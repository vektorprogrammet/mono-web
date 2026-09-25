import { Database } from "../service.js";
import {
  markOutboxDelivered,
  markOutboxFailed,
  outboxClaimAssignments,
  quarantineOutboxClaim,
  recoverStaleOutboxClaims,
  releaseOutboxClaim,
  type OutboxTable,
} from "../outbox-lifecycle.js";
import { Data, Predicate, Effect, Schema } from "effect";
import {
  type PublicApplicationEffectEvidence,
  type PublicApplicationEffectInterpreter,
  PublicApplicationOutboxRequestSchema,
  type PublicApplicationOutboxRequest,
} from "@vektorprogrammet/domain/application";
import { publicApplicationActivationDigest } from "@vektorprogrammet/domain/application";
import { PublicApplicationPersistenceError } from "@vektorprogrammet/domain/application";

interface ClaimedOutboxRow {
  readonly effect_id: string;
  readonly command_id: string;
  readonly effect_type: string;
  readonly application_id: string;
  readonly applicant_id: string;
  readonly ordinal: number;
  readonly attempts: number;
  readonly payload_json: unknown;
  readonly origin: string;
}

interface CanonicalOutboxIdentityRow {
  readonly email: string;
  readonly application_activation_digest: string | null;
  readonly department_id: string;
  readonly receipt_application_id: string;
  readonly audit_application_id: string;
  readonly audit_applicant_id: string;
  readonly linked_person_id: string | null;
  readonly linked_registration_id: string | null;
}

export interface ClaimedPublicApplicationOutbox {
  readonly effectId: string;
  readonly commandId: string;
  readonly ordinal: number;
  readonly attempts: number;
  readonly claimId: string;
  readonly request: PublicApplicationOutboxRequest;
}

export type PublicApplicationOutboxDeliveryResult =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Delivered";
      readonly claim: ClaimedPublicApplicationOutbox;
      readonly evidence: PublicApplicationEffectEvidence;
    }
  | {
      readonly _tag: "Failed";
      readonly claim: ClaimedPublicApplicationOutbox;
      readonly failureTag: string;
    };

export const PublicApplicationOutboxDeliveryResult =
  Data.taggedEnum<PublicApplicationOutboxDeliveryResult>();

const persistenceError = (operation: string): PublicApplicationPersistenceError =>
  new PublicApplicationPersistenceError({
    operation,
    message: "public application persistence failed",
  });

const applicationOutbox: OutboxTable = {
  name: "admission_application_outbox",
  terminalPayload: "Scrub",
};

export const claimNextPublicApplicationOutbox = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  ClaimedPublicApplicationOutbox | undefined,
  PublicApplicationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    const quarantine = (effectId: string, failureTag: string) =>
      quarantineOutboxClaim(sql, applicationOutbox, { effectId, claimId }, failureTag).pipe(
        Effect.asVoid,
      );

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<ClaimedOutboxRow>`
            WITH candidate AS (
              SELECT outbox.effect_id
              FROM admission_application_outbox AS outbox
              LEFT JOIN admission_application_command_receipts AS public_receipt
                ON public_receipt.command_id = outbox.command_id
              LEFT JOIN admission_returning_command_receipts AS returning_receipt
                ON returning_receipt.command_id = outbox.command_id
              WHERE outbox.status IN ('Pending', 'Failed')
                AND (public_receipt.command_id IS NOT NULL OR returning_receipt.command_id IS NOT NULL)
                AND NOT EXISTS (
                  SELECT 1
                  FROM admission_application_outbox AS predecessor
                  WHERE predecessor.command_id = outbox.command_id
                    AND predecessor.ordinal < outbox.ordinal
                    AND predecessor.status <> 'Delivered'
                )
              ORDER BY outbox.attempts,
                COALESCE(public_receipt.committed_at, returning_receipt.committed_at),
                outbox.command_id, outbox.ordinal
              FOR UPDATE OF outbox SKIP LOCKED
              LIMIT 1
            )
            UPDATE admission_application_outbox AS claimed
            SET ${outboxClaimAssignments(sql, "claimed", claimId, claimedAt)}
            FROM candidate
            WHERE claimed.effect_id = candidate.effect_id
            RETURNING claimed.effect_id, claimed.effect_type, claimed.application_id,
              claimed.applicant_id, claimed.command_id, claimed.ordinal, claimed.attempts,
              claimed.payload_json, claimed.origin
          `;

          const row = rows[0];

          if (row === undefined) return undefined;

          const decoded = yield* Schema.decodeUnknownEffect(PublicApplicationOutboxRequestSchema)(
            row.payload_json,
            { onExcessProperty: "error" },
          ).pipe(
            Effect.match({
              onFailure: () => ({ _tag: "Invalid" as const }),
              onSuccess: (request) => ({ _tag: "Valid" as const, request }),
            }),
          );

          if (Predicate.isTagged(decoded, "Invalid")) {
            yield* quarantine(row.effect_id, "InvalidPublicApplicationEffectPayload");

            return undefined;
          }

          const request = decoded.request;
          const requestOrigin = "origin" in request ? request.origin : undefined;

          const effectTypeMatchesOrdinal =
            (row.ordinal === 0 && row.effect_type === "SendApplicantActivationOrConfirmation") ||
            (row.ordinal === 1 && row.effect_type === "CreateAdmissionSubscription") ||
            (row.ordinal === 2 && row.effect_type === "WriteApplicationAudit");

          if (
            !effectTypeMatchesOrdinal ||
            request.effectId !== row.effect_id ||
            request._tag !== row.effect_type ||
            request.applicationId !== row.application_id ||
            request.applicantId !== row.applicant_id ||
            request.commandId !== row.command_id ||
            (row.origin === "ReturningAssistant"
              ? requestOrigin !== "ReturningAssistant"
              : requestOrigin !== undefined)
          ) {
            yield* quarantine(row.effect_id, "InvalidPublicApplicationEffectEnvelope");

            return undefined;
          }

          let identities: ReadonlyArray<CanonicalOutboxIdentityRow>;

          if (row.origin === "ReturningAssistant") {
            identities = yield* sql<CanonicalOutboxIdentityRow>`
              SELECT applicant.email,
                NULL::text AS application_activation_digest,
                registration.department_id,
                registration.application_id AS receipt_application_id,
                registration.application_id AS audit_application_id,
                registration.applicant_id AS audit_applicant_id,
                registration.person_id AS linked_person_id,
                registration.registration_id AS linked_registration_id
              FROM admission_returning_command_receipts AS receipt
              INNER JOIN admission_returning_registrations AS registration
                ON registration.registration_id = receipt.registration_id
                AND registration.command_id = receipt.command_id
              INNER JOIN admission_applicants AS applicant
                ON applicant.applicant_id = registration.applicant_id
              WHERE receipt.command_id = ${row.command_id}
                AND registration.application_id = ${row.application_id}
                AND registration.applicant_id = ${row.applicant_id}
            `;
          } else {
            identities = yield* sql<CanonicalOutboxIdentityRow>`
              SELECT applicant.email,
                application.activation_digest AS application_activation_digest,
                application.department_id,
                receipt.application_id AS receipt_application_id,
                audit.application_id AS audit_application_id,
                audit.applicant_id AS audit_applicant_id,
                NULL::text AS linked_person_id,
                NULL::text AS linked_registration_id
              FROM admission_applicants AS applicant
              INNER JOIN admission_applications AS application
                ON application.applicant_id = applicant.applicant_id
              INNER JOIN admission_application_command_receipts AS receipt
                ON receipt.command_id = ${row.command_id}
              INNER JOIN admission_application_audit AS audit
                ON audit.command_id = receipt.command_id
              WHERE applicant.applicant_id = ${row.applicant_id}
                AND application.application_id = ${row.application_id}
            `;
          }

          const identity = identities[0];

          if (identity === undefined) {
            yield* quarantine(row.effect_id, "InvalidPublicApplicationEffectAuthority");

            return undefined;
          }

          const requestPersonId = "personId" in request ? request.personId : undefined;

          const requestRegistrationId =
            "registrationId" in request ? request.registrationId : undefined;

          const transactionMatchesCanonicalState =
            identity.receipt_application_id === row.application_id &&
            identity.audit_application_id === row.application_id &&
            identity.audit_applicant_id === row.applicant_id &&
            (row.origin !== "ReturningAssistant" ||
              (identity.linked_person_id !== null &&
                identity.linked_registration_id !== null &&
                requestPersonId === identity.linked_person_id &&
                requestRegistrationId === identity.linked_registration_id &&
                requestOrigin === "ReturningAssistant"));

          const requestMatchesCanonicalState = Predicate.isTagged(
            request,
            "SendApplicantActivationOrConfirmation",
          )
            ? request.email === identity.email &&
              (!("activationToken" in request) || request.activationToken === undefined
                ? identity.application_activation_digest === null
                : publicApplicationActivationDigest(request.activationToken) ===
                  identity.application_activation_digest)
            : Predicate.isTagged(request, "CreateAdmissionSubscription")
              ? request.email === identity.email && request.departmentId === identity.department_id
              : request.action ===
                (row.origin === "ReturningAssistant"
                  ? "ReturningAssistantRegistered"
                  : "PublicApplicationSubmitted");

          if (!transactionMatchesCanonicalState || !requestMatchesCanonicalState) {
            yield* quarantine(row.effect_id, "InvalidPublicApplicationEffectAuthority");

            return undefined;
          }

          return {
            effectId: row.effect_id,
            commandId: row.command_id,
            ordinal: row.ordinal,
            attempts: row.attempts,
            claimId,
            request,
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(persistenceError("claim application outbox")),
        ),
      );
  });

export const completePublicApplicationOutbox = (
  claim: ClaimedPublicApplicationOutbox,
): Effect.Effect<void, PublicApplicationPersistenceError, Database> =>
  Database.use((sql) => markOutboxDelivered(sql, applicationOutbox, claim)).pipe(
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("complete application outbox"))),
    Effect.flatMap((delivered) =>
      delivered ? Effect.void : Effect.fail(persistenceError("complete application outbox")),
    ),
  );

export const failPublicApplicationOutbox = (
  claim: ClaimedPublicApplicationOutbox,
  failureTag: string,
): Effect.Effect<void, PublicApplicationPersistenceError, Database> =>
  Database.use((sql) => markOutboxFailed(sql, applicationOutbox, claim, failureTag)).pipe(
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("fail application outbox"))),
    Effect.flatMap((failed) =>
      failed ? Effect.void : Effect.fail(persistenceError("fail application outbox")),
    ),
  );

export const releasePublicApplicationOutbox = (
  claim: ClaimedPublicApplicationOutbox,
): Effect.Effect<void, PublicApplicationPersistenceError, Database> =>
  Database.use((sql) =>
    releaseOutboxClaim(sql, applicationOutbox, claim, "InterruptedPublicApplicationOutboxClaim"),
  ).pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", () => Effect.fail(persistenceError("release application outbox"))),
  );

export const recoverAllStalePublicApplicationOutbox = (
  claimedBefore: string,
): Effect.Effect<number, PublicApplicationPersistenceError, Database> =>
  Database.use((sql) =>
    recoverStaleOutboxClaims(sql, applicationOutbox, claimedBefore, {
      status: "Pending",
      failureTag: "StalePublicApplicationOutboxClaim",
    }),
  ).pipe(
    Effect.catchTag("SqlError", () =>
      Effect.fail(persistenceError("recover all application outbox claims")),
    ),
  );

export const deliverNextPublicApplicationOutbox = (
  claimId: string,
  claimedAt: string,
  interpreter: PublicApplicationEffectInterpreter,
): Effect.Effect<
  PublicApplicationOutboxDeliveryResult,
  PublicApplicationPersistenceError,
  Database
> =>
  Effect.acquireUseRelease(
    claimNextPublicApplicationOutbox(claimId, claimedAt),
    (
      claim,
    ): Effect.Effect<
      PublicApplicationOutboxDeliveryResult,
      PublicApplicationPersistenceError,
      Database
    > => {
      if (claim === undefined) return Effect.succeed(PublicApplicationOutboxDeliveryResult.Idle());

      return interpreter.deliver(claim.request, claim.ordinal, claim.attempts).pipe(
        Effect.matchEffect({
          onFailure: (failure) =>
            failPublicApplicationOutbox(claim, failure._tag).pipe(
              Effect.as(
                PublicApplicationOutboxDeliveryResult.Failed({ claim, failureTag: failure._tag }),
              ),
            ),
          onSuccess: (evidence) =>
            completePublicApplicationOutbox(claim).pipe(
              Effect.as(PublicApplicationOutboxDeliveryResult.Delivered({ claim, evidence })),
            ),
        }),
      );
    },
    (claim) => (claim === undefined ? Effect.void : releasePublicApplicationOutbox(claim)),
  );
