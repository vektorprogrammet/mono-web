import { Admissions, type AdmissionsOperations } from "@vektorprogrammet/domain/admissions";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { Database, type DatabaseOperations } from "../service.js";
import { NotificationGateway } from "@vektorprogrammet/domain/notification";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Profile, type ProfileOperations } from "@vektorprogrammet/domain/profile";
import { compareRfc3339Instants } from "@vektorprogrammet/domain/time";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { flow, Data, Predicate, Effect, Schema } from "effect";
import { RecruitmentPersistenceError } from "@vektorprogrammet/domain/recruitment";
import {
  RecruitmentInvitationResponseOutboxRequestSchema,
  RecruitmentInvitationResponseOutboxRequestFieldSchemas,
  type RecruitmentInvitationResponseOutboxRequest,
  type RecruitmentNotificationDeliveryError,
  type RecruitmentNotificationEvidence,
} from "@vektorprogrammet/domain/recruitment";
import {
  RecruitmentInstantSchema,
  RecruitmentInvitationResponseMessageSchema,
} from "@vektorprogrammet/domain/recruitment";

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
  readonly envelopeSha256: string | null;
  readonly superseded: boolean;
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
  envelopeSha256: Schema.NullOr(Schema.String),
  superseded: Schema.Boolean,
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

export const RecruitmentInvitationResponseDeliveryResult =
  Data.taggedEnum<RecruitmentInvitationResponseDeliveryResult>();

const persistenceError = (operation: string, cause?: unknown): RecruitmentPersistenceError =>
  new RecruitmentPersistenceError({
    operation,
    cause,
    message:
      cause instanceof Error ? cause.message : "recruitment response outbox persistence failed",
  });

const decodeForClaim = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.map((decoded) => ({ _tag: "Decoded" as const, value: decoded })),
    Effect.catch(() => Effect.succeed({ _tag: "Invalid" as const })),
  );

const quarantineResponseClaim = (
  sql: DatabaseOperations,
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
  sql: DatabaseOperations,
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

const validateEnvelope = (
  sql: DatabaseOperations,
  admissions: AdmissionsOperations,
  profile: ProfileOperations,
  rawRow: ClaimedInvitationResponseRow,
  claimId: string,
  reject: (tag: string) => Effect.Effect<undefined, RecruitmentPersistenceError>,
): Effect.Effect<ClaimedRecruitmentInvitationResponse | undefined, RecruitmentPersistenceError> =>
  Effect.gen(function* () {
    const decodedRow = yield* decodeForClaim(ClaimedInvitationResponseRowSchema)(rawRow);

    if (!Predicate.isTagged(decodedRow, "Decoded")) {
      return yield* reject("RecruitmentDecodeError");
    }

    const row = decodedRow.value;

    if (row.claimId !== claimId) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const decodedRequest = yield* decodeForClaim(RecruitmentInvitationResponseOutboxRequestSchema)(
      row.payloadJson,
    );

    if (!Predicate.isTagged(decodedRequest, "Decoded")) {
      return yield* reject("RecruitmentDecodeError");
    }

    const request = decodedRequest.value;

    const canonicalRows = yield* sql<CanonicalInvitationResponseRow>`
      SELECT
        audit.envelope_sha256 AS "envelopeSha256",
        invitation.superseded_at IS NOT NULL AS superseded,
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
      FOR SHARE OF audit, invitation, interview, schedule
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read canonical invitation response envelope", cause)),
      ),
    );

    if (canonicalRows.length !== 1) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    if (canonicalRows[0]?.superseded === true) return yield* reject("SupersededRecruitmentInvitation");

    const decodedCanonical = yield* decodeForClaim(CanonicalInvitationResponseRowSchema)(
      canonicalRows[0],
    );

    if (
      !Predicate.isTagged(decodedCanonical, "Decoded") ||
      !canonicalEnvelopeMatches(row, request, decodedCanonical.value)
    ) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const canonical = decodedCanonical.value;
    const envelopeSha256 = sha256Hex(canonicalJsonBytes(request));

    if (canonical.envelopeSha256 !== null) {
      if (canonical.envelopeSha256 !== envelopeSha256)
        return yield* reject("AuthorityEnvelopeMismatch");

      return { effectId: row.effectId, claimId: row.claimId, attempts: row.attempts, request };
    }

    const applicantRead = yield* admissions.readApplicantContacts([canonical.applicationId]).pipe(
      Effect.map((contacts) => ({ _tag: "Read" as const, contacts })),
      Effect.catch((failure) =>
        Predicate.isTagged(failure, "PublicApplicationPersistenceError")
          ? Effect.fail(persistenceError("read response applicant contact", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );

    if (Predicate.isTagged(applicantRead, "Missing") || applicantRead.contacts.length !== 1) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const applicant = applicantRead.contacts[0];

    if (
      applicant === undefined ||
      applicant.applicationId !== canonical.applicationId ||
      request.applicantDisplayName !== `${applicant.firstName} ${applicant.lastName}`
    ) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const interviewerRead = yield* profile.readContacts([canonical.interviewerPersonId]).pipe(
      Effect.map((contacts) => ({ _tag: "Read" as const, contacts })),
      Effect.catch((failure) =>
        Predicate.isTagged(failure, "ProfilePersistenceError")
          ? Effect.fail(persistenceError("read response interviewer contact", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );

    if (Predicate.isTagged(interviewerRead, "Missing") || interviewerRead.contacts.length !== 1) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const interviewer = interviewerRead.contacts[0];

    if (
      interviewer === undefined ||
      interviewer.personId !== canonical.interviewerPersonId ||
      request.interviewerEmail !== interviewer.email ||
      request.interviewerPhone !== interviewer.phone
    ) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    yield* sql`UPDATE public.recruitment_invitation_response_audit SET envelope_sha256=${envelopeSha256} WHERE invitation_id=${row.invitationId} AND envelope_sha256 IS NULL`.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("seal delivery envelope", cause)),
      ),
    );

    return {
      effectId: row.effectId,
      claimId: row.claimId,
      attempts: row.attempts,
      request,
    };
  });

const claimInTransaction = (
  sql: DatabaseOperations,
  admissions: AdmissionsOperations,
  profile: ProfileOperations,
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
          AND EXISTS (
            SELECT 1 FROM recruitment_invitations AS invitation
            WHERE invitation.invitation_id = outbox.invitation_id
              AND invitation.superseded_at IS NULL
          )
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

    return yield* validateEnvelope(sql, admissions, profile, rawRow, claimId, (tag) =>
      quarantineAndSkip(sql, rawRow, tag),
    );
  });

export const sealInterviewResponseEnvelopes = (interviewId: string) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const admissions = yield* Admissions;
    const profile = yield* Profile;

    const rows =
      yield* sql<ClaimedInvitationResponseRow>`SELECT outbox.effect_id AS "effectId",outbox.effect_type AS "effectType",outbox.response_revision AS "responseRevision",outbox.response_state AS "responseState",outbox.response_message AS "responseMessage",
    outbox.interview_id AS "interviewId",outbox.invitation_id AS "invitationId",outbox.schedule_revision AS "scheduleRevision",outbox.ordinal,
    'legacy-seal'::text AS "claimId",outbox.attempts+1 AS attempts,outbox.payload_json AS "payloadJson"
    FROM public.recruitment_invitation_response_outbox outbox JOIN public.recruitment_invitation_response_audit audit ON audit.invitation_id=outbox.invitation_id
    WHERE outbox.interview_id=${interviewId} AND outbox.status IN ('Pending','Failed','Processing') AND audit.envelope_sha256 IS NULL
      AND EXISTS (SELECT 1 FROM public.recruitment_invitations invitation
        WHERE invitation.invitation_id=outbox.invitation_id AND invitation.superseded_at IS NULL)
    ORDER BY outbox.effect_id FOR UPDATE OF outbox`;

    for (const row of rows)
      yield* validateEnvelope(sql, admissions, profile, row, "legacy-seal", (tag) =>
        Effect.fail(persistenceError("seal legacy response envelope: " + tag)),
      );
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("seal legacy envelopes", cause)),
    ),
  );

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
      if (claim === undefined)
        return Effect.succeed(RecruitmentInvitationResponseDeliveryResult.Idle());

      return Effect.gen(function* () {
        const gateway = yield* NotificationGateway;

        return yield* gateway.deliverInterviewInvitationResponse(claim.request).pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              failRecruitmentInvitationResponse(claim, failure._tag).pipe(
                Effect.as(
                  RecruitmentInvitationResponseDeliveryResult.Failed({
                    claim,
                    failureTag: failure._tag,
                  }),
                ),
              ),
            onSuccess: (evidence) =>
              completeRecruitmentInvitationResponse(claim, evidence).pipe(
                Effect.as(
                  RecruitmentInvitationResponseDeliveryResult.Delivered({ claim, evidence }),
                ),
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
