import {
  SchoolServiceNotificationDeliveryError,
  SchoolServiceNotificationOutboxError,
  SchoolServiceNotificationRequest,
  type SchoolServiceNotificationRequest as SchoolServiceNotificationRequestType,
} from "@vektorprogrammet/domain/placements";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { Effect, Schema } from "effect";
import { Database, type DatabaseShape } from "../service.js";

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

export type SchoolServiceNotificationInterpreter = (
  request: SchoolServiceNotificationRequestType,
) => Effect.Effect<void, SchoolServiceNotificationDeliveryError>;

const outboxError = (operation: string, cause?: unknown) =>
  new SchoolServiceNotificationOutboxError({
    operation,
    message: cause instanceof Error ? cause.message : "school service notification outbox failed",
  });

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => outboxError("decode school service notification", cause)),
  );

const quarantine = (sql: DatabaseShape, effectId: string, claimId: string, failureTag: string) =>
  sql`UPDATE public.school_service_notification_outbox SET status='Quarantined',claim_id=NULL,claimed_at=NULL,last_failure_tag=${failureTag} WHERE effect_id=${effectId} AND status='Processing' AND claim_id=${claimId}`.pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(outboxError("quarantine school service notification", cause)),
    ),
  );

const claimInTransaction = (sql: DatabaseShape, claimId: string, claimedAt: string) =>
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
      SET status='Processing',claim_id=${claimId},claimed_at=${claimedAt},
        attempts=outbox.attempts+1,last_failure_tag=NULL
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
    const decodedRow = yield* decode(ClaimedRow, row).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(undefined),
        onSuccess: Effect.succeed,
      }),
    );
    if (decodedRow === undefined || decodedRow.claimId !== claimId) {
      yield* quarantine(sql, row.effectId, claimId, "SchoolServiceDecodeError");
      return {
        _tag: "Quarantined" as const,
        effectId: row.effectId,
        failureTag: "SchoolServiceDecodeError" as const,
      };
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
        : yield* decode(CanonicalRow, canonicalRows[0]).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.succeed(undefined),
              onSuccess: Effect.succeed,
            }),
          );
    const request = yield* decode(SchoolServiceNotificationRequest, decodedRow.payloadJson).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(undefined),
        onSuccess: Effect.succeed,
      }),
    );
    const assignments =
      canonical !== undefined && Array.isArray(canonical.assignments)
        ? canonical.assignments.filter(
            (assignment) =>
              typeof assignment === "object" &&
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
      return {
        _tag: "Quarantined" as const,
        effectId: decodedRow.effectId,
        failureTag: "AuthorityEnvelopeMismatch" as const,
      };
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
    sql<{
      readonly count: string;
    }>`WITH recovered AS (UPDATE public.school_service_notification_outbox SET status='Failed',claim_id=NULL,claimed_at=NULL,last_failure_tag='StaleClaim' WHERE status='Processing' AND claimed_at<${claimedBefore} RETURNING 1) SELECT count(*)::text AS count FROM recovered`.pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
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
    if (selected === undefined) return { _tag: "Idle" as const };
    if (selected._tag === "Quarantined") {
      return {
        _tag: "Quarantined" as const,
        effectId: selected.effectId,
        failureTag: selected.failureTag,
      };
    }
    const claim = selected.claim;
    return yield* interpreter(claim.request).pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          Database.use(
            (sql) =>
              sql`UPDATE public.school_service_notification_outbox SET status='Failed',claim_id=NULL,claimed_at=NULL,last_failure_tag=${failure._tag} WHERE effect_id=${claim.effectId} AND status='Processing' AND claim_id=${claim.claimId}`,
          ).pipe(
            Effect.as({ _tag: "Failed" as const, claim, failureTag: failure._tag }),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(outboxError("fail school service notification", cause)),
            ),
          ),
        onSuccess: () =>
          Database.use(
            (sql) =>
              sql`UPDATE public.school_service_notification_outbox SET status='Delivered',claim_id=NULL,claimed_at=NULL,delivered_at=${claimedAt},last_failure_tag=NULL WHERE effect_id=${claim.effectId} AND status='Processing' AND claim_id=${claim.claimId}`,
          ).pipe(
            Effect.as({ _tag: "Delivered" as const, claim }),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(outboxError("deliver school service notification", cause)),
            ),
          ),
      }),
    );
  });
