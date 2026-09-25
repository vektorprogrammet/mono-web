import {
  SchoolServiceNotificationDeliveryError,
  SchoolServiceNotificationOutboxError,
  SchoolServiceNotificationRequest,
  type SchoolServiceNotificationRequest as SchoolServiceNotificationRequestType,
} from "@vektorprogrammet/placements/contracts";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { flow, Data, Predicate, Effect, Schema } from "effect";
import { Database, type DatabaseOperations } from "@vektorprogrammet/database";
import {
  markOutboxDelivered,
  markOutboxFailed,
  outboxClaimAssignments,
  quarantineOutboxClaim,
  recoverStaleOutboxClaims,
  type OutboxTable,
} from "@vektorprogrammet/database/outbox-lifecycle";

const ClaimedRow = Schema.Struct({
  effectId: Schema.String,
  proposalId: Schema.String,
  personId: Schema.String,
  claimId: Schema.String,
  attempts: Schema.Int,
  payloadJson: Schema.Unknown,
});

const CanonicalRow = Schema.Struct({
  proposalId: Schema.String,
  departmentId: Schema.String,
  semesterId: Schema.String,
  status: Schema.String,
  confirmedAt: Schema.String,
  assignments: Schema.Unknown,
});

type ClaimedRow = typeof ClaimedRow.Type;

export interface ClaimedSchoolServiceNotification {
  readonly effectId: string;
  readonly claimId: string;
  readonly attempts: number;
  readonly request: SchoolServiceNotificationRequestType;
}

export type SchoolServiceNotificationDeliveryResult =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Delivered"; readonly claim: ClaimedSchoolServiceNotification }
  | {
      readonly _tag: "Failed";
      readonly claim: ClaimedSchoolServiceNotification;
      readonly failureTag: string;
    }
  | { readonly _tag: "Quarantined"; readonly effectId: string; readonly failureTag: string };

export const SchoolServiceNotificationDeliveryResult =
  Data.taggedEnum<SchoolServiceNotificationDeliveryResult>();

export type SchoolServiceNotificationInterpreter = (
  request: SchoolServiceNotificationRequestType,
) => Effect.Effect<void, SchoolServiceNotificationDeliveryError>;

const outboxError = (operation: string, cause?: unknown) =>
  new SchoolServiceNotificationOutboxError({
    operation,
    message: cause instanceof Error ? cause.message : "school service notification outbox failed",
  });

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError((cause) => outboxError("decode school service notification", cause)),
  );

const notificationOutbox: OutboxTable = {
  name: "public.school_service_notification_outbox",
  terminalPayload: "Retain",
};

const quarantine = (
  sql: DatabaseOperations,
  effectId: string,
  claimId: string,
  failureTag: string,
) =>
  quarantineOutboxClaim(sql, notificationOutbox, { effectId, claimId }, failureTag).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(outboxError("quarantine school service notification", cause)),
    ),
  );

const claimInTransaction = (sql: DatabaseOperations, claimId: string, claimedAt: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<ClaimedRow>`
      WITH candidate AS (
        SELECT effect_id
        FROM public.school_service_notification_outbox
        WHERE status IN ('Pending','Failed')
        ORDER BY attempts,effect_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.school_service_notification_outbox AS outbox
      SET ${outboxClaimAssignments(sql, "outbox", claimId, claimedAt)}
      FROM candidate
      WHERE outbox.effect_id=candidate.effect_id
      RETURNING outbox.effect_id AS "effectId",outbox.proposal_id AS "proposalId",
        outbox.person_id AS "personId",outbox.claim_id AS "claimId",
        outbox.attempts,outbox.payload_json AS "payloadJson"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(outboxError("claim school service notification", cause)),
      ),
    );

    const row = rows[0];

    if (row === undefined) return undefined;

    const decodedRow = yield* decode(ClaimedRow)(row).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(undefined),
        onSuccess: Effect.succeed,
      }),
    );

    if (decodedRow === undefined || decodedRow.claimId !== claimId) {
      yield* quarantine(sql, row.effectId, claimId, "SchoolServiceDecodeError");

      return SchoolServiceNotificationDeliveryResult.Quarantined({
        effectId: row.effectId,
        failureTag: "SchoolServiceDecodeError" as const,
      });
    }

    const canonicalRows = yield* sql<{
      proposalId: string;
      departmentId: string;
      semesterId: string;
      status: string;
      confirmedAt: string;
      assignments: unknown;
    }>`SELECT proposal_id AS "proposalId",department_id AS "departmentId",semester_id AS "semesterId",status,to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "confirmedAt",assignment_snapshot AS assignments FROM public.school_service_proposals WHERE proposal_id=${decodedRow.proposalId} FOR SHARE`;

    const canonical =
      canonicalRows[0] === undefined
        ? undefined
        : yield* decode(CanonicalRow)(canonicalRows[0]).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.succeed(undefined),
              onSuccess: Effect.succeed,
            }),
          );

    const request = yield* decode(SchoolServiceNotificationRequest)(decodedRow.payloadJson).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(undefined),
        onSuccess: Effect.succeed,
      }),
    );

    const assignments =
      canonical !== undefined && Array.isArray(canonical.assignments)
        ? canonical.assignments.filter(
            (assignment) =>
              (assignment === null || Predicate.isObjectOrArray(assignment)) &&
              assignment !== null &&
              "personId" in assignment &&
              assignment.personId === decodedRow.personId,
          )
        : [];

    const valid =
      canonical !== undefined &&
      request !== undefined &&
      canonical.status === "Confirmed" &&
      request.effectId === decodedRow.effectId &&
      request.effectId ===
        `school-service-notification:${decodedRow.proposalId}:${decodedRow.personId}` &&
      request.proposalId === decodedRow.proposalId &&
      request.personId === decodedRow.personId &&
      request.departmentId === canonical.departmentId &&
      request.semesterId === canonical.semesterId &&
      request.confirmedAt === canonical.confirmedAt &&
      assignments.length > 0 &&
      canonicalJson(request.assignments) === canonicalJson(assignments);

    if (!valid) {
      yield* quarantine(sql, decodedRow.effectId, decodedRow.claimId, "AuthorityEnvelopeMismatch");

      return SchoolServiceNotificationDeliveryResult.Quarantined({
        effectId: decodedRow.effectId,
        failureTag: "AuthorityEnvelopeMismatch" as const,
      });
    }

    return {
      _tag: "Claimed" as const,
      claim: {
        effectId: decodedRow.effectId,
        claimId: decodedRow.claimId,
        attempts: decodedRow.attempts,
        request,
      },
    };
  });

export const claimNextSchoolServiceNotification = (claimId: string, claimedAt: string) =>
  Database.use((sql) =>
    sql
      .withTransaction(claimInTransaction(sql, claimId, claimedAt))
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(outboxError("claim school service notification", cause)),
        ),
      ),
  );

export const recoverStaleSchoolServiceNotifications = (claimedBefore: string) =>
  Database.use((sql) =>
    recoverStaleOutboxClaims(sql, notificationOutbox, claimedBefore, {
      status: "Failed",
      failureTag: "StaleClaim",
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(outboxError("recover school service notification claims", cause)),
      ),
    ),
  );

export const deliverNextSchoolServiceNotification = (
  claimId: string,
  claimedAt: string,
  interpreter: SchoolServiceNotificationInterpreter,
): Effect.Effect<
  SchoolServiceNotificationDeliveryResult,
  SchoolServiceNotificationOutboxError,
  Database
> =>
  Effect.gen(function* () {
    const selected = yield* claimNextSchoolServiceNotification(claimId, claimedAt);

    if (selected === undefined) return SchoolServiceNotificationDeliveryResult.Idle();

    if (Predicate.isTagged(selected, "Quarantined")) {
      return SchoolServiceNotificationDeliveryResult.Quarantined({
        effectId: selected.effectId,
        failureTag: selected.failureTag,
      });
    }

    const claim = selected.claim;

    return yield* interpreter(claim.request).pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          Database.use((sql) =>
            markOutboxFailed(sql, notificationOutbox, claim, failure._tag),
          ).pipe(
            Effect.as(
              SchoolServiceNotificationDeliveryResult.Failed({ claim, failureTag: failure._tag }),
            ),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(outboxError("fail school service notification", cause)),
            ),
          ),
        onSuccess: () =>
          Database.use((sql) =>
            markOutboxDelivered(sql, notificationOutbox, claim, { deliveredAt: claimedAt }),
          ).pipe(
            Effect.as(SchoolServiceNotificationDeliveryResult.Delivered({ claim })),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(outboxError("deliver school service notification", cause)),
            ),
          ),
      }),
    );
  });
