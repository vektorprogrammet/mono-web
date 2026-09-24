import {
  SchoolServiceDispatchNotificationDeliveryError,
  SchoolServiceDispatchNotificationOutboxError,
  SchoolServiceDispatchNotificationRequest,
  type SchoolServiceDispatchNotificationRequest as SchoolServiceDispatchNotificationRequestType,
} from "@vektorprogrammet/domain/placements";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { flow, Data, Predicate, Effect, Schema } from "effect";
import { Database, type DatabaseOperations } from "../service.js";

const ClaimedRow = Schema.Struct({
  effectId: Schema.String,
  offerId: Schema.String,
  absenceId: Schema.String,
  personId: Schema.String,
  claimId: Schema.String,
  attempts: Schema.Int,
  payloadJson: Schema.Unknown,
});

const CanonicalRow = Schema.Struct({
  offerId: Schema.String,
  absenceId: Schema.String,
  personId: Schema.String,
  proposalId: Schema.String,
  departmentId: Schema.String,
  semesterId: Schema.String,
  schoolId: Schema.Number,
  schoolNameSnapshot: Schema.String,
  day: Schema.String,
  block: Schema.String,
  serviceDate: Schema.String,
  startTime: Schema.NullOr(Schema.String),
  endTime: Schema.NullOr(Schema.String),
  dispatchedAt: Schema.String,
});

type ClaimedRow = typeof ClaimedRow.Type;

export interface ClaimedSchoolServiceDispatchNotification {
  readonly effectId: string;
  readonly claimId: string;
  readonly attempts: number;
  readonly request: SchoolServiceDispatchNotificationRequestType;
}

export type SchoolServiceDispatchNotificationDeliveryResult =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Delivered"; readonly claim: ClaimedSchoolServiceDispatchNotification }
  | {
      readonly _tag: "Failed";
      readonly claim: ClaimedSchoolServiceDispatchNotification;
      readonly failureTag: string;
    }
  | { readonly _tag: "Quarantined"; readonly effectId: string; readonly failureTag: string };

export const SchoolServiceDispatchNotificationDeliveryResult =
  Data.taggedEnum<SchoolServiceDispatchNotificationDeliveryResult>();

export type SchoolServiceDispatchNotificationInterpreter = (
  request: SchoolServiceDispatchNotificationRequestType,
) => Effect.Effect<void, SchoolServiceDispatchNotificationDeliveryError>;

const outboxError = (operation: string, cause?: unknown) =>
  new SchoolServiceDispatchNotificationOutboxError({
    operation,
    message:
      cause instanceof Error ? cause.message : "school service dispatch notification outbox failed",
  });

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError((cause) => outboxError("decode school service dispatch notification", cause)),
  );

const quarantine = (
  sql: DatabaseOperations,
  effectId: string,
  claimId: string,
  failureTag: string,
) =>
  sql`UPDATE public.school_service_dispatch_notification_outbox SET status='Quarantined',claim_id=NULL,claimed_at=NULL,last_failure_tag=${failureTag} WHERE effect_id=${effectId} AND status='Processing' AND claim_id=${claimId}`.pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(outboxError("quarantine school service dispatch notification", cause)),
    ),
  );

const claimInTransaction = (sql: DatabaseOperations, claimId: string, claimedAt: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<ClaimedRow>`
      WITH candidate AS (
        SELECT effect_id
        FROM public.school_service_dispatch_notification_outbox
        WHERE status IN ('Pending','Failed')
        ORDER BY attempts,effect_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.school_service_dispatch_notification_outbox AS outbox
      SET status='Processing',claim_id=${claimId},claimed_at=${claimedAt},
        attempts=outbox.attempts+1,last_failure_tag=NULL
      FROM candidate
      WHERE outbox.effect_id=candidate.effect_id
      RETURNING outbox.effect_id AS "effectId",outbox.offer_id AS "offerId",
        outbox.absence_id AS "absenceId",outbox.person_id AS "personId",outbox.claim_id AS "claimId",
        outbox.attempts,outbox.payload_json AS "payloadJson"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(outboxError("claim school service dispatch notification", cause)),
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
      yield* quarantine(sql, row.effectId, claimId, "SchoolServiceDispatchDecodeError");

      return SchoolServiceDispatchNotificationDeliveryResult.Quarantined({
        effectId: row.effectId,
        failureTag: "SchoolServiceDispatchDecodeError" as const,
      });
    }

    const canonicalRows = yield* sql<{
      readonly offerId: string;
      readonly absenceId: string;
      readonly personId: string;
      readonly proposalId: string;
      readonly departmentId: string;
      readonly semesterId: string;
      readonly schoolId: number;
      readonly schoolNameSnapshot: string;
      readonly day: string;
      readonly block: string;
      readonly serviceDate: string;
      readonly startTime: string | null;
      readonly endTime: string | null;
      readonly dispatchedAt: string;
    }>`
      SELECT offer.offer_id AS "offerId",absence.absence_id AS "absenceId",
        offer.candidate_person_id AS "personId",absence.proposal_id AS "proposalId",
        absence.department_id AS "departmentId",absence.semester_id AS "semesterId",
        absence.school_id::double precision AS "schoolId",
        offer.school_name_snapshot AS "schoolNameSnapshot",
        absence.day,absence.block,to_char(absence.service_date,'YYYY-MM-DD') AS "serviceDate",
        to_char(commitment.start_time,'HH24:MI') AS "startTime",
        to_char(commitment.end_time,'HH24:MI') AS "endTime",
        to_char(offer.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dispatchedAt"
      FROM public.school_service_substitute_offers AS offer
      JOIN public.school_service_absences AS absence USING(absence_id)
      LEFT JOIN public.school_service_commitments AS commitment ON commitment.commitment_id=absence.commitment_id
      WHERE offer.offer_id=${decodedRow.offerId}
      FOR SHARE OF offer,absence
    `;

    const canonical =
      canonicalRows[0] === undefined
        ? undefined
        : yield* decode(CanonicalRow)(canonicalRows[0]).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.succeed(undefined),
              onSuccess: Effect.succeed,
            }),
          );

    const request = yield* decode(SchoolServiceDispatchNotificationRequest)(
      decodedRow.payloadJson,
    ).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(undefined),
        onSuccess: Effect.succeed,
      }),
    );

    const expected =
      canonical === undefined
        ? undefined
        : {
            _tag: "NotifySchoolServiceSubstituteOffer" as const,
            effectId: `school-service-substitute-dispatch:${canonical.offerId}`,
            offerId: canonical.offerId,
            absenceId: canonical.absenceId,
            personId: canonical.personId,
            proposalId: canonical.proposalId,
            departmentId: canonical.departmentId,
            semesterId: canonical.semesterId,
            schoolId: canonical.schoolId,
            schoolName: canonical.schoolNameSnapshot,
            day: canonical.day,
            block: canonical.block,
            serviceDate: canonical.serviceDate,
            dispatchedAt: canonical.dispatchedAt,
          };

    const expectedWithTime =
      expected === undefined ||
      canonical === undefined ||
      canonical.startTime === null ||
      canonical.endTime === null
        ? expected
        : { ...expected, startTime: canonical.startTime, endTime: canonical.endTime };

    if (
      request === undefined ||
      expected === undefined ||
      decodedRow.effectId !== expected.effectId ||
      decodedRow.offerId !== expected.offerId ||
      decodedRow.absenceId !== expected.absenceId ||
      decodedRow.personId !== expected.personId ||
      canonicalJson(request) !== canonicalJson(expectedWithTime)
    ) {
      yield* quarantine(sql, decodedRow.effectId, decodedRow.claimId, "AuthorityEnvelopeMismatch");

      return SchoolServiceDispatchNotificationDeliveryResult.Quarantined({
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

export const claimNextSchoolServiceDispatchNotification = (claimId: string, claimedAt: string) =>
  Database.use((sql) =>
    sql
      .withTransaction(claimInTransaction(sql, claimId, claimedAt))
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(outboxError("claim school service dispatch notification", cause)),
        ),
      ),
  );

export const recoverStaleSchoolServiceDispatchNotifications = (claimedBefore: string) =>
  Database.use((sql) =>
    sql<{
      readonly count: string;
    }>`WITH recovered AS (UPDATE public.school_service_dispatch_notification_outbox SET status='Failed',claim_id=NULL,claimed_at=NULL,last_failure_tag='StaleClaim' WHERE status='Processing' AND claimed_at<${claimedBefore} RETURNING 1) SELECT count(*)::text AS count FROM recovered`.pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 0)),
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(outboxError("recover school service dispatch notification claims", cause)),
      ),
    ),
  );

export const deliverNextSchoolServiceDispatchNotification = (
  claimId: string,
  claimedAt: string,
  interpreter: SchoolServiceDispatchNotificationInterpreter,
): Effect.Effect<
  SchoolServiceDispatchNotificationDeliveryResult,
  SchoolServiceDispatchNotificationOutboxError,
  Database
> =>
  Effect.gen(function* () {
    const selected = yield* claimNextSchoolServiceDispatchNotification(claimId, claimedAt);

    if (selected === undefined) return SchoolServiceDispatchNotificationDeliveryResult.Idle();

    if (Predicate.isTagged(selected, "Quarantined")) {
      return SchoolServiceDispatchNotificationDeliveryResult.Quarantined({
        effectId: selected.effectId,
        failureTag: selected.failureTag,
      });
    }

    const claim = selected.claim;

    return yield* interpreter(claim.request).pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          Database.use(
            (sql) =>
              sql`UPDATE public.school_service_dispatch_notification_outbox SET status='Failed',claim_id=NULL,claimed_at=NULL,last_failure_tag=${failure._tag} WHERE effect_id=${claim.effectId} AND status='Processing' AND claim_id=${claim.claimId}`,
          ).pipe(
            Effect.as(
              SchoolServiceDispatchNotificationDeliveryResult.Failed({
                claim,
                failureTag: failure._tag,
              }),
            ),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(outboxError("fail school service dispatch notification", cause)),
            ),
          ),
        onSuccess: () =>
          Database.use(
            (sql) =>
              sql`UPDATE public.school_service_dispatch_notification_outbox SET status='Delivered',claim_id=NULL,claimed_at=NULL,delivered_at=${claimedAt},last_failure_tag=NULL WHERE effect_id=${claim.effectId} AND status='Processing' AND claim_id=${claim.claimId}`,
          ).pipe(
            Effect.as(SchoolServiceDispatchNotificationDeliveryResult.Delivered({ claim })),
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(outboxError("deliver school service dispatch notification", cause)),
            ),
          ),
      }),
    );
  });
