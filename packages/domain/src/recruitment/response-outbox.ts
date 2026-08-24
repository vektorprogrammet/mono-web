import { Admissions, type AdmissionsShape } from "../admissions/service.js";
import { PublicApplicationIdSchema } from "../application/schema.js";
import { Database, type DatabaseShape } from "../database/service.js";
import { NotificationGateway } from "../notification/service.js";
import { PersonId } from "../organization/schema.js";
import { Profile, type ProfileShape } from "../profile/service.js";
import { compareRfc3339Instants } from "../time.js";
import { canonicalJson } from "../tutor/evidence.js";
import { Effect, Schema } from "effect";
import { RecruitmentPersistenceError } from "./errors.js";
import {
  RecruitmentInvitationResponseOutboxRequestSchema,
  RecruitmentInvitationResponseOutboxRequestFieldSchemas,
  type RecruitmentInvitationResponseOutboxRequest,
  type RecruitmentNotificationDeliveryError,
  type RecruitmentNotificationEvidence,
} from "./effects.js";
import { RecruitmentInstantSchema, RecruitmentInvitationResponseMessageSchema } from "./schema.js";

interface ClaimedInvitationResponseRow {
  readonly effectId: string;
  readonly effectType: string;
  readonly invitationId: string;
  readonly interviewId: string;
  readonly scheduleRevision: number;
  readonly responseRevision: number;
  readonly responseState: string;
  readonly responseMessage: string | null;
  readonly ordinal: number;
  readonly claimId: string;
  readonly attempts: number;
  readonly payloadJson: unknown;
}

const ClaimedInvitationResponseRowSchema = Schema.Struct({
  effectId: RecruitmentInvitationResponseOutboxRequestFieldSchemas.effectId,
  effectType: Schema.String,
  invitationId: RecruitmentInvitationResponseOutboxRequestFieldSchemas.invitationId,
  interviewId: RecruitmentInvitationResponseOutboxRequestFieldSchemas.interviewId,
  scheduleRevision: RecruitmentInvitationResponseOutboxRequestFieldSchemas.scheduleRevision,
  responseRevision: RecruitmentInvitationResponseOutboxRequestFieldSchemas.responseRevision,
  responseState: Schema.Literals(["Rejected", "RequestedNewTime"]),
  responseMessage: Schema.NullOr(RecruitmentInvitationResponseMessageSchema),
  ordinal: Schema.Int,
  claimId: Schema.String,
  attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  payloadJson: Schema.Unknown,
});

interface CanonicalInvitationResponseRow {
  readonly auditInvitationId: string;
  readonly auditInterviewId: string;
  readonly auditScheduleRevision: number;
  readonly auditResponseRevision: number;
  readonly auditResponseState: string;
  readonly auditResponseMessage: string | null;
  readonly auditRespondedAt: string;
  readonly invitationInterviewId: string;
  readonly invitationScheduleRevision: number;
  readonly invitationResponseRevision: number;
  readonly invitationResponseState: string;
  readonly invitationResponseMessage: string | null;
  readonly invitationRespondedAt: string;
  readonly applicationId: string;
  readonly interviewerPersonId: string;
  readonly scheduledAt: string;
}

const CanonicalInvitationResponseRowSchema = Schema.Struct({
  auditInvitationId: RecruitmentInvitationResponseOutboxRequestFieldSchemas.invitationId,
  auditInterviewId: RecruitmentInvitationResponseOutboxRequestFieldSchemas.interviewId,
  auditScheduleRevision: RecruitmentInvitationResponseOutboxRequestFieldSchemas.scheduleRevision,
  auditResponseRevision: RecruitmentInvitationResponseOutboxRequestFieldSchemas.responseRevision,
  auditResponseState: Schema.Literals(["Rejected", "RequestedNewTime"]),
  auditResponseMessage: Schema.NullOr(RecruitmentInvitationResponseMessageSchema),
  auditRespondedAt: RecruitmentInstantSchema,
  invitationInterviewId: RecruitmentInvitationResponseOutboxRequestFieldSchemas.interviewId,
  invitationScheduleRevision:
    RecruitmentInvitationResponseOutboxRequestFieldSchemas.scheduleRevision,
  invitationResponseRevision:
    RecruitmentInvitationResponseOutboxRequestFieldSchemas.responseRevision,
  invitationResponseState: Schema.Literals(["Rejected", "RequestedNewTime"]),
  invitationResponseMessage: Schema.NullOr(RecruitmentInvitationResponseMessageSchema),
  invitationRespondedAt: RecruitmentInstantSchema,
  applicationId: PublicApplicationIdSchema,
  interviewerPersonId: PersonId,
  scheduledAt: RecruitmentInvitationResponseOutboxRequestFieldSchemas.scheduledAt,
});

export interface ClaimedRecruitmentInvitationResponse {
  readonly effectId: string;
  readonly claimId: string;
  readonly attempts: number;
  readonly request: RecruitmentInvitationResponseOutboxRequest;
}

export type RecruitmentInvitationResponseDeliveryResult =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Delivered";
      readonly claim: ClaimedRecruitmentInvitationResponse;
      readonly evidence: RecruitmentNotificationEvidence;
    }
  | {
      readonly _tag: "Failed";
      readonly claim: ClaimedRecruitmentInvitationResponse;
      readonly failureTag: string;
    };

const persistenceError = (operation: string, cause?: unknown): RecruitmentPersistenceError =>
  new RecruitmentPersistenceError({
    operation,
    message:
      cause instanceof Error ? cause.message : "recruitment response outbox persistence failed",
  });

type DecodeOutcome<A> =
  | { readonly _tag: "Decoded"; readonly value: A }
  | { readonly _tag: "Invalid" };

const decodeForClaim = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  value: unknown,
): Effect.Effect<DecodeOutcome<A>> =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.map((decoded) => ({ _tag: "Decoded" as const, value: decoded })),
    Effect.catch(() => Effect.succeed({ _tag: "Invalid" as const })),
  );

const quarantineResponseClaim = (
  sql: DatabaseShape,
  effectId: string,
  claimId: string,
  failureTag: string,
): Effect.Effect<void, RecruitmentPersistenceError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_response_outbox
      SET status = 'Quarantined',
        claim_id = NULL,
        claimed_at = NULL,
        last_failure_tag = ${failureTag},
        payload_json = '{}'::jsonb
      WHERE effect_id = ${effectId}
        AND status = 'Processing'
        AND claim_id = ${claimId}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("quarantine invitation response claim", cause)),
      ),
    );
    if (rows.length !== 1 || rows[0]?.effectId !== effectId) {
      return yield* persistenceError("quarantine missing invitation response claim");
    }
  });

const quarantineAndSkip = (
  sql: DatabaseShape,
  row: Pick<ClaimedInvitationResponseRow, "effectId" | "claimId">,
  failureTag: string,
): Effect.Effect<undefined, RecruitmentPersistenceError> =>
  quarantineResponseClaim(sql, row.effectId, row.claimId, failureTag).pipe(Effect.as(undefined));

const canonicalEnvelopeMatches = (
  row: typeof ClaimedInvitationResponseRowSchema.Type,
  request: RecruitmentInvitationResponseOutboxRequest,
  canonical: typeof CanonicalInvitationResponseRowSchema.Type,
): boolean => {
  const expectedEffectId = `recruitment-invitation-response:${canonical.auditInvitationId}:${canonical.auditResponseRevision}`;
  return (
    row.effectType === "SendInterviewInvitationResponse" &&
    row.ordinal === 0 &&
    request._tag === row.effectType &&
    request.effectId === row.effectId &&
    request.invitationId === row.invitationId &&
    request.interviewId === row.interviewId &&
    request.scheduleRevision === row.scheduleRevision &&
    request.responseRevision === row.responseRevision &&
    request.responseState === row.responseState &&
    request.responseMessage === row.responseMessage &&
    row.effectId === expectedEffectId &&
    canonical.auditInvitationId === row.invitationId &&
    canonical.auditInterviewId === row.interviewId &&
    canonical.auditScheduleRevision === row.scheduleRevision &&
    canonical.auditResponseRevision === row.responseRevision &&
    canonical.auditResponseState === row.responseState &&
    canonical.auditResponseMessage === row.responseMessage &&
    canonical.invitationInterviewId === row.interviewId &&
    canonical.invitationScheduleRevision === row.scheduleRevision &&
    canonical.invitationResponseRevision === row.responseRevision &&
    canonical.invitationResponseState === row.responseState &&
    canonical.invitationResponseMessage === row.responseMessage &&
    compareRfc3339Instants(canonical.auditRespondedAt, canonical.invitationRespondedAt) === 0 &&
    compareRfc3339Instants(request.scheduledAt, canonical.scheduledAt) === 0
  );
};

const claimInTransaction = (
  sql: DatabaseShape,
  admissions: AdmissionsShape,
  profile: ProfileShape,
  claimId: string,
  claimedAt: string,
): Effect.Effect<ClaimedRecruitmentInvitationResponse | undefined, RecruitmentPersistenceError> =>
  Effect.gen(function* () {
    const rows = yield* sql<ClaimedInvitationResponseRow>`
      WITH candidate AS (
        SELECT outbox.effect_id
        FROM recruitment_invitation_response_outbox AS outbox
        INNER JOIN recruitment_invitation_response_audit AS audit
          ON audit.invitation_id = outbox.invitation_id
        WHERE outbox.status IN ('Pending', 'Failed')
        ORDER BY outbox.attempts ASC,
          audit.responded_at ASC,
          outbox.invitation_id ASC,
          outbox.ordinal ASC
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT 1
      )
      UPDATE recruitment_invitation_response_outbox AS outbox
      SET status = 'Processing',
        claim_id = ${claimId},
        claimed_at = ${claimedAt},
        attempts = outbox.attempts + 1,
        last_failure_tag = NULL
      FROM candidate
      WHERE outbox.effect_id = candidate.effect_id
      RETURNING
        outbox.effect_id AS "effectId",
        outbox.effect_type AS "effectType",
        outbox.invitation_id AS "invitationId",
        outbox.interview_id AS "interviewId",
        outbox.schedule_revision AS "scheduleRevision",
        outbox.response_revision AS "responseRevision",
        outbox.response_state AS "responseState",
        outbox.response_message AS "responseMessage",
        outbox.ordinal,
        outbox.claim_id AS "claimId",
        outbox.attempts,
        outbox.payload_json AS "payloadJson"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("claim invitation response outbox", cause)),
      ),
    );
    const rawRow = rows[0];
    if (rawRow === undefined) return undefined;
    const decodedRow = yield* decodeForClaim(ClaimedInvitationResponseRowSchema, rawRow);
    if (decodedRow._tag === "Invalid") {
      return yield* quarantineAndSkip(
        sql,
        { effectId: rawRow.effectId, claimId },
        "RecruitmentDecodeError",
      );
    }
    const row = decodedRow.value;
    if (row.claimId !== claimId) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const decodedRequest = yield* decodeForClaim(
      RecruitmentInvitationResponseOutboxRequestSchema,
      row.payloadJson,
    );
    if (decodedRequest._tag === "Invalid") {
      return yield* quarantineAndSkip(sql, row, "RecruitmentDecodeError");
    }
    const request = decodedRequest.value;

    const canonicalRows = yield* sql<CanonicalInvitationResponseRow>`
      SELECT
        audit.invitation_id AS "auditInvitationId",
        audit.interview_id AS "auditInterviewId",
        audit.schedule_revision AS "auditScheduleRevision",
        audit.response_revision AS "auditResponseRevision",
        audit.response_state AS "auditResponseState",
        audit.response_message AS "auditResponseMessage",
        to_char(
          audit.responded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "auditRespondedAt",
        invitation.interview_id AS "invitationInterviewId",
        invitation.schedule_revision AS "invitationScheduleRevision",
        invitation.response_revision AS "invitationResponseRevision",
        invitation.response_state AS "invitationResponseState",
        invitation.response_message AS "invitationResponseMessage",
        to_char(
          invitation.responded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "invitationRespondedAt",
        interview.application_id AS "applicationId",
        interview.interviewer_person_id AS "interviewerPersonId",
        to_char(
          schedule.scheduled_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "scheduledAt"
      FROM recruitment_invitation_response_outbox AS outbox
      INNER JOIN recruitment_invitation_response_audit AS audit
        ON audit.invitation_id = outbox.invitation_id
        AND audit.interview_id = outbox.interview_id
        AND audit.schedule_revision = outbox.schedule_revision
        AND audit.response_revision = outbox.response_revision
        AND audit.response_state = outbox.response_state
      INNER JOIN recruitment_invitations AS invitation
        ON invitation.invitation_id = audit.invitation_id
        AND invitation.interview_id = audit.interview_id
        AND invitation.schedule_revision = audit.schedule_revision
        AND invitation.response_revision = audit.response_revision
      INNER JOIN recruitment_interviews AS interview
        ON interview.interview_id = audit.interview_id
      INNER JOIN recruitment_interview_schedules AS schedule
        ON schedule.interview_id = audit.interview_id
        AND schedule.schedule_revision = audit.schedule_revision
      WHERE outbox.effect_id = ${row.effectId}
        AND outbox.status = 'Processing'
        AND outbox.claim_id = ${row.claimId}
      FOR SHARE OF audit, invitation, interview, schedule
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read canonical invitation response envelope", cause)),
      ),
    );
    if (canonicalRows.length !== 1) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const decodedCanonical = yield* decodeForClaim(
      CanonicalInvitationResponseRowSchema,
      canonicalRows[0],
    );
    if (
      decodedCanonical._tag === "Invalid" ||
      !canonicalEnvelopeMatches(row, request, decodedCanonical.value)
    ) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const canonical = decodedCanonical.value;

    const applicantRead = yield* admissions.readApplicantContacts([canonical.applicationId]).pipe(
      Effect.map((contacts) => ({ _tag: "Read" as const, contacts })),
      Effect.catch((failure) =>
        failure._tag === "PublicApplicationPersistenceError"
          ? Effect.fail(persistenceError("read response applicant contact", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );
    if (applicantRead._tag === "Missing" || applicantRead.contacts.length !== 1) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const applicant = applicantRead.contacts[0];
    if (
      applicant === undefined ||
      applicant.applicationId !== canonical.applicationId ||
      request.applicantDisplayName !== `${applicant.firstName} ${applicant.lastName}`
    ) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }

    const interviewerRead = yield* profile.readContacts([canonical.interviewerPersonId]).pipe(
      Effect.map((contacts) => ({ _tag: "Read" as const, contacts })),
      Effect.catch((failure) =>
        failure._tag === "ProfilePersistenceError"
          ? Effect.fail(persistenceError("read response interviewer contact", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );
    if (interviewerRead._tag === "Missing" || interviewerRead.contacts.length !== 1) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const interviewer = interviewerRead.contacts[0];
    if (
      interviewer === undefined ||
      interviewer.personId !== canonical.interviewerPersonId ||
      request.interviewerEmail !== interviewer.email ||
      request.interviewerPhone !== interviewer.phone
    ) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }

    return {
      effectId: row.effectId,
      claimId: row.claimId,
      attempts: row.attempts,
      request,
    };
  });

export const claimNextRecruitmentInvitationResponse = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  ClaimedRecruitmentInvitationResponse | undefined,
  RecruitmentPersistenceError,
  Admissions | Database | Profile
> =>
  Effect.gen(function* () {
    const admissions = yield* Admissions;
    const sql = yield* Database;
    const profile = yield* Profile;
    return yield* sql
      .withTransaction(claimInTransaction(sql, admissions, profile, claimId, claimedAt))
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("invitation response claim transaction", cause)),
        ),
      );
  });

export const completeRecruitmentInvitationResponse = (
  claim: ClaimedRecruitmentInvitationResponse,
  evidence: RecruitmentNotificationEvidence,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_response_outbox
      SET status = 'Delivered',
        claim_id = NULL,
        claimed_at = NULL,
        delivered_at = ${evidence.deliveredAt},
        last_failure_tag = NULL,
        payload_json = '{}'::jsonb
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("complete invitation response claim", cause)),
      ),
    );
    if (rows[0]?.effectId !== claim.effectId) {
      return yield* persistenceError("complete missing invitation response claim");
    }
  });

export const failRecruitmentInvitationResponse = (
  claim: ClaimedRecruitmentInvitationResponse,
  failureTag: string,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_response_outbox
      SET status = 'Failed',
        claim_id = NULL,
        claimed_at = NULL,
        last_failure_tag = ${failureTag}
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("fail invitation response claim", cause)),
      ),
    );
    if (rows[0]?.effectId !== claim.effectId) {
      return yield* persistenceError("fail missing invitation response claim");
    }
  });

export const releaseRecruitmentInvitationResponse = (
  claim: ClaimedRecruitmentInvitationResponse,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    yield* sql`
      UPDATE recruitment_invitation_response_outbox
      SET status = 'Pending',
        claim_id = NULL,
        claimed_at = NULL,
        last_failure_tag = 'InterruptedRecruitmentInvitationResponseClaim'
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("release invitation response claim", cause)),
      ),
    );
  });

export const recoverStaleRecruitmentInvitationResponses = (
  claimedBefore: string,
): Effect.Effect<number, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_response_outbox
      SET status = 'Failed',
        claim_id = NULL,
        claimed_at = NULL,
        last_failure_tag = 'StaleClaimRecovered'
      WHERE status = 'Processing'
        AND claimed_at < ${claimedBefore}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("recover stale invitation response claims", cause)),
      ),
    );
    return rows.length;
  });

export const deliverNextRecruitmentInvitationResponse = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  RecruitmentInvitationResponseDeliveryResult,
  RecruitmentPersistenceError,
  Admissions | Database | NotificationGateway | Profile
> =>
  Effect.acquireUseRelease(
    claimNextRecruitmentInvitationResponse(claimId, claimedAt),
    (
      claim,
    ): Effect.Effect<
      RecruitmentInvitationResponseDeliveryResult,
      RecruitmentPersistenceError,
      Admissions | Database | NotificationGateway | Profile
    > => {
      if (claim === undefined) return Effect.succeed({ _tag: "Idle" as const });
      return Effect.gen(function* () {
        const gateway = yield* NotificationGateway;
        return yield* gateway.deliverInterviewInvitationResponse(claim.request).pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              failRecruitmentInvitationResponse(claim, failure._tag).pipe(
                Effect.as({ _tag: "Failed" as const, claim, failureTag: failure._tag }),
              ),
            onSuccess: (evidence) =>
              completeRecruitmentInvitationResponse(claim, evidence).pipe(
                Effect.as({ _tag: "Delivered" as const, claim, evidence }),
              ),
          }),
        );
      });
    },
    (claim) => (claim === undefined ? Effect.void : releaseRecruitmentInvitationResponse(claim)),
  );

export const invitationResponsePayloadForEvidence = (
  request: RecruitmentInvitationResponseOutboxRequest,
): string => canonicalJson(request);

export type RecruitmentInvitationResponseOutboxFailure =
  | RecruitmentPersistenceError
  | RecruitmentNotificationDeliveryError;
