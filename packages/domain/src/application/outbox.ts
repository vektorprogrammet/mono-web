import { Database } from "../database/service.js";
import { Effect, Schema } from "effect";
import {
  type PublicApplicationEffectEvidence,
  type PublicApplicationEffectInterpreter,
  PublicApplicationOutboxRequestSchema,
  type PublicApplicationOutboxRequest,
} from "./effects.js";
import { publicApplicationActivationDigest } from "./digest.js";
import { PublicApplicationPersistenceError } from "./errors.js";

interface ClaimedOutboxRow {
  readonly effect_id: string;
  readonly command_id: string;
  readonly effect_type: string;
  readonly application_id: string;
  readonly applicant_id: string;
  readonly ordinal: number;
  readonly attempts: number;
  readonly payload_json: unknown;
}

interface CanonicalOutboxIdentityRow {
  readonly email: string;
  readonly activation_digest: string | null;
  readonly department_id: string;
}

interface CountRow {
  readonly count: string;
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

const persistenceError = (operation: string): PublicApplicationPersistenceError =>
  new PublicApplicationPersistenceError({
    operation,
    message: "public application persistence failed",
  });

const requireSingleUpdate = (
  rows: ReadonlyArray<unknown>,
  operation: string,
): Effect.Effect<void, PublicApplicationPersistenceError> =>
  rows.length === 1 ? Effect.void : Effect.fail(persistenceError(operation));

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
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<ClaimedOutboxRow>`
            WITH candidate AS (
              SELECT outbox.effect_id
              FROM admission_application_outbox AS outbox
              INNER JOIN admission_application_command_receipts AS receipt
                ON receipt.command_id = outbox.command_id
              WHERE outbox.status IN ('Pending', 'Failed')
                AND NOT EXISTS (
                  SELECT 1
                  FROM admission_application_outbox AS predecessor
                  WHERE predecessor.command_id = outbox.command_id
                    AND predecessor.ordinal < outbox.ordinal
                    AND predecessor.status <> 'Delivered'
                )
              ORDER BY outbox.attempts, receipt.committed_at, outbox.command_id, outbox.ordinal
              FOR UPDATE OF outbox SKIP LOCKED
              LIMIT 1
            )
            UPDATE admission_application_outbox AS claimed
            SET status = 'Processing',
              attempts = claimed.attempts + 1,
              claim_id = ${claimId},
              claimed_at = ${claimedAt},
              last_failure_tag = NULL
            FROM candidate
            WHERE claimed.effect_id = candidate.effect_id
            RETURNING claimed.effect_id, claimed.effect_type, claimed.application_id,
              claimed.applicant_id, claimed.command_id, claimed.ordinal, claimed.attempts,
              claimed.payload_json
          `;
          const row = rows[0];
          if (row === undefined) return undefined;
          const request = yield* Schema.decodeUnknownEffect(PublicApplicationOutboxRequestSchema)(
            row.payload_json,
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError(() => persistenceError("decode application outbox request")));
          if (
            request.effectId !== row.effect_id ||
            request._tag !== row.effect_type ||
            request.applicationId !== row.application_id ||
            request.applicantId !== row.applicant_id ||
            request.commandId !== row.command_id
          ) {
            return yield* Effect.fail(
              persistenceError("application outbox durable envelope mismatch"),
            );
          }
          const identities = yield* sql<CanonicalOutboxIdentityRow>`
            SELECT applicant.email, applicant.activation_digest, application.department_id
            FROM admission_applicants AS applicant
            INNER JOIN admission_applications AS application
              ON application.applicant_id = applicant.applicant_id
            WHERE applicant.applicant_id = ${row.applicant_id}
              AND application.application_id = ${row.application_id}
          `;
          const identity = identities[0];
          if (identity === undefined) {
            return yield* Effect.fail(
              persistenceError("application outbox canonical identity mismatch"),
            );
          }
          const requestMatchesCanonicalState =
            request._tag === "SendApplicantActivationOrConfirmation"
              ? request.email === identity.email &&
                (request.activationToken === undefined
                  ? identity.activation_digest === null
                  : publicApplicationActivationDigest(request.activationToken) ===
                    identity.activation_digest)
              : request._tag === "CreateAdmissionSubscription"
                ? request.email === identity.email &&
                  request.departmentId === identity.department_id
                : true;
          if (!requestMatchesCanonicalState) {
            return yield* Effect.fail(
              persistenceError("application outbox canonical payload mismatch"),
            );
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
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effect_id: string }>`
    UPDATE admission_application_outbox
    SET status = 'Delivered', claim_id = NULL, claimed_at = NULL,
      last_failure_tag = NULL, payload_json = '{}'::jsonb
    WHERE effect_id = ${claim.effectId}
      AND status = 'Processing'
      AND claim_id = ${claim.claimId}
    RETURNING effect_id
  `.pipe(
      Effect.catchTag("SqlError", () =>
        Effect.fail(persistenceError("complete application outbox")),
      ),
    );
    yield* requireSingleUpdate(rows, "complete application outbox");
  });

export const failPublicApplicationOutbox = (
  claim: ClaimedPublicApplicationOutbox,
  failureTag: string,
): Effect.Effect<void, PublicApplicationPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effect_id: string }>`
    UPDATE admission_application_outbox
    SET status = 'Failed', claim_id = NULL, claimed_at = NULL,
      last_failure_tag = ${failureTag}
    WHERE effect_id = ${claim.effectId}
      AND status = 'Processing'
      AND claim_id = ${claim.claimId}
    RETURNING effect_id
  `.pipe(
      Effect.catchTag("SqlError", () => Effect.fail(persistenceError("fail application outbox"))),
    );
    yield* requireSingleUpdate(rows, "fail application outbox");
  });

export const releasePublicApplicationOutbox = (
  claim: ClaimedPublicApplicationOutbox,
): Effect.Effect<void, PublicApplicationPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    yield* sql`
      UPDATE admission_application_outbox
      SET status = 'Pending', claim_id = NULL, claimed_at = NULL,
        last_failure_tag = 'InterruptedPublicApplicationOutboxClaim'
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", () =>
        Effect.fail(persistenceError("release application outbox")),
      ),
    );
  });

export const recoverAllStalePublicApplicationOutbox = (
  claimedBefore: string,
): Effect.Effect<number, PublicApplicationPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<CountRow>`
      WITH recovered AS (
        UPDATE admission_application_outbox
        SET status = 'Pending', claim_id = NULL, claimed_at = NULL,
          last_failure_tag = 'StalePublicApplicationOutboxClaim'
        WHERE status = 'Processing'
          AND claimed_at < ${claimedBefore}
        RETURNING 1
      )
      SELECT count(*)::text AS count FROM recovered
    `.pipe(
      Effect.catchTag("SqlError", () =>
        Effect.fail(persistenceError("recover all application outbox claims")),
      ),
    );
    return Number(rows[0]?.count ?? "0");
  });

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
      if (claim === undefined) return Effect.succeed({ _tag: "Idle" as const });
      return interpreter.deliver(claim.request, claim.ordinal, claim.attempts).pipe(
        Effect.matchEffect({
          onFailure: (failure) =>
            failPublicApplicationOutbox(claim, failure._tag).pipe(
              Effect.as({ _tag: "Failed" as const, claim, failureTag: failure._tag }),
            ),
          onSuccess: (evidence) =>
            completePublicApplicationOutbox(claim).pipe(
              Effect.as({ _tag: "Delivered" as const, claim, evidence }),
            ),
        }),
      );
    },
    (claim) => (claim === undefined ? Effect.void : releasePublicApplicationOutbox(claim)),
  );
