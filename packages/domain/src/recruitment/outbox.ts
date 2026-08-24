import { Admissions, type AdmissionsShape } from "../admissions/service.js";
import { Database, type DatabaseShape } from "../database/service.js";
import { NotificationGateway } from "../notification/service.js";
import { Profile, type ProfileShape } from "../profile/service.js";
import { personProfileDisplayName } from "../profile/schema.js";
import { compareRfc3339Instants } from "../time.js";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { Effect, Schema } from "effect";
import { RecruitmentPersistenceError } from "./errors.js";
import {
  RecruitmentInvitationOutboxRequestSchema,
  type RecruitmentInvitationOutboxRequest,
  type RecruitmentNotificationDeliveryError,
  type RecruitmentNotificationEvidence,
} from "./effects.js";
import {
  RecruitmentInterview,
  RecruitmentInterviewSchedule,
  RecruitmentInvitation,
  RecruitmentScheduleCommandSchema,
  RecruitmentScheduleObservationSchema,
  type RecruitmentScheduleCommand,
  type RecruitmentScheduleObservation,
} from "./schema.js";

interface ClaimedInvitationRow {
  readonly effectId: string;
  readonly effectType: string;
  readonly commandId: string;
  readonly interviewId: string;
  readonly invitationId: string;
  readonly scheduleRevision: number;
  readonly ordinal: number;
  readonly claimId: string;
  readonly attempts: number;
  readonly payloadJson: unknown;
}

const ClaimedInvitationRowSchema = Schema.Struct({
  effectId: RecruitmentInvitationOutboxRequestSchema.fields.effectId,
  effectType: Schema.String,
  commandId: RecruitmentInvitationOutboxRequestSchema.fields.commandId,
  interviewId: RecruitmentInvitationOutboxRequestSchema.fields.interviewId,
  invitationId: RecruitmentInvitationOutboxRequestSchema.fields.invitationId,
  scheduleRevision: RecruitmentInvitationOutboxRequestSchema.fields.scheduleRevision,
  ordinal: Schema.Int,
  claimId: Schema.String,
  attempts: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  payloadJson: Schema.Unknown,
});

interface CanonicalInvitationEnvelopeRow {
  readonly receiptCommandId: string;
  readonly receiptCommandSha256: string;
  readonly receiptCommandJson: unknown;
  readonly receiptObservationJson: unknown;
  readonly receiptInterviewId: string;
  readonly receiptScheduleRevision: number;
  readonly receiptCommittedAt: string;
  readonly canonicalInterviewId: string;
  readonly applicationId: string;
  readonly interviewerPersonId: string;
  readonly interviewRevision: number;
  readonly scheduleInterviewId: string;
  readonly scheduledAt: string;
  readonly room: string;
  readonly campus: string | null;
  readonly mapLink: string | null;
  readonly message: string;
  readonly scheduledByPersonId: string;
  readonly scheduleCommittedAt: string;
  readonly canonicalScheduleRevision: number;
  readonly canonicalInvitationId: string;
  readonly invitationInterviewId: string;
  readonly invitationScheduleRevision: number;
  readonly capabilitySha256: string;
  readonly responseState: string;
  readonly invitationCreatedAt: string;
}

const CanonicalInvitationEnvelopeRowSchema = Schema.Struct({
  receiptCommandId: RecruitmentInvitationOutboxRequestSchema.fields.commandId,
  receiptCommandSha256: Schema.String,
  receiptCommandJson: Schema.Unknown,
  receiptObservationJson: Schema.Unknown,
  receiptInterviewId: RecruitmentInterview.fields.interviewId,
  receiptScheduleRevision: RecruitmentInvitationOutboxRequestSchema.fields.scheduleRevision,
  receiptCommittedAt: RecruitmentInterviewSchedule.fields.committedAt,
  canonicalInterviewId: RecruitmentInterview.fields.interviewId,
  applicationId: RecruitmentInterview.fields.applicationId,
  interviewerPersonId: RecruitmentInterview.fields.interviewerPersonId,
  interviewRevision: RecruitmentInterview.fields.revision,
  scheduleInterviewId: RecruitmentInterviewSchedule.fields.interviewId,
  scheduledAt: RecruitmentInterviewSchedule.fields.scheduledAt,
  room: RecruitmentInterviewSchedule.fields.room,
  campus: RecruitmentInterviewSchedule.fields.campus,
  mapLink: RecruitmentInterviewSchedule.fields.mapLink,
  message: RecruitmentInterviewSchedule.fields.message,
  scheduledByPersonId: RecruitmentInterviewSchedule.fields.scheduledByPersonId,
  scheduleCommittedAt: RecruitmentInterviewSchedule.fields.committedAt,
  canonicalScheduleRevision: RecruitmentInterviewSchedule.fields.scheduleRevision,
  canonicalInvitationId: RecruitmentInvitation.fields.invitationId,
  invitationInterviewId: RecruitmentInvitation.fields.interviewId,
  invitationScheduleRevision: RecruitmentInvitation.fields.scheduleRevision,
  capabilitySha256: RecruitmentInvitation.fields.capabilitySha256,
  responseState: RecruitmentInvitation.fields.responseState,
  invitationCreatedAt: RecruitmentInvitation.fields.createdAt,
});

export interface ClaimedRecruitmentInvitation {
  readonly effectId: string;
  readonly claimId: string;
  readonly attempts: number;
  readonly request: RecruitmentInvitationOutboxRequest;
}

export type RecruitmentInvitationDeliveryResult =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Delivered";
      readonly claim: ClaimedRecruitmentInvitation;
      readonly evidence: RecruitmentNotificationEvidence;
    }
  | {
      readonly _tag: "Failed";
      readonly claim: ClaimedRecruitmentInvitation;
      readonly failureTag: string;
    };

const persistenceError = (operation: string, cause?: unknown): RecruitmentPersistenceError =>
  new RecruitmentPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : "recruitment outbox persistence failed",
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

const quarantineClaim = (
  sql: DatabaseShape,
  effectId: string,
  claimId: string,
  failureTag: string,
): Effect.Effect<void, RecruitmentPersistenceError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_outbox
      SET status = 'Quarantined', claim_id = NULL, claimed_at = NULL,
        last_failure_tag = ${failureTag}, payload_json = '{}'::jsonb
      WHERE effect_id = ${effectId}
        AND status = 'Processing'
        AND claim_id = ${claimId}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("quarantine invitation outbox claim", cause)),
      ),
    );
    if (rows.length !== 1 || rows[0]?.effectId !== effectId) {
      return yield* persistenceError("quarantine missing invitation outbox claim");
    }
  });

const quarantineAndSkip = (
  sql: DatabaseShape,
  row: Pick<ClaimedInvitationRow, "effectId" | "claimId">,
  failureTag: string,
): Effect.Effect<undefined, RecruitmentPersistenceError> =>
  quarantineClaim(sql, row.effectId, row.claimId, failureTag).pipe(Effect.as(undefined));

const sameInstant = (left: string, right: string): boolean =>
  compareRfc3339Instants(left, right) === 0;

const canonicalEnvelopeMatches = (
  row: typeof ClaimedInvitationRowSchema.Type,
  request: RecruitmentInvitationOutboxRequest,
  canonical: typeof CanonicalInvitationEnvelopeRowSchema.Type,
  command: RecruitmentScheduleCommand,
  observation: RecruitmentScheduleObservation,
): boolean => {
  const expectedCommandSha256 = sha256Hex(canonicalJsonBytes(command));
  const expectedEffectId = `recruitment-invitation:${canonical.receiptCommandSha256}`;
  const responseCapabilitySha256 = sha256Hex(new TextEncoder().encode(request.responseCapability));
  const observedSchedule = observation.schedule;
  return (
    row.effectType === "SendInterviewInvitation" &&
    row.ordinal === 0 &&
    request._tag === row.effectType &&
    request.effectId === row.effectId &&
    request.commandId === row.commandId &&
    request.interviewId === row.interviewId &&
    request.invitationId === row.invitationId &&
    request.scheduleRevision === row.scheduleRevision &&
    canonical.receiptCommandId === row.commandId &&
    canonical.receiptInterviewId === row.interviewId &&
    canonical.receiptScheduleRevision === row.scheduleRevision &&
    canonical.canonicalInterviewId === row.interviewId &&
    canonical.interviewRevision === row.scheduleRevision &&
    canonical.scheduleInterviewId === row.interviewId &&
    canonical.canonicalScheduleRevision === row.scheduleRevision &&
    canonical.canonicalInvitationId === row.invitationId &&
    canonical.invitationInterviewId === row.interviewId &&
    canonical.invitationScheduleRevision === row.scheduleRevision &&
    canonical.responseState === "Pending" &&
    responseCapabilitySha256 === canonical.capabilitySha256 &&
    /^[a-f0-9]{64}$/u.test(canonical.receiptCommandSha256) &&
    canonical.receiptCommandSha256 === expectedCommandSha256 &&
    row.effectId === expectedEffectId &&
    request.effectId === expectedEffectId &&
    command.commandId === row.commandId &&
    command.interviewId === row.interviewId &&
    command.expectedRevision + 1 === row.scheduleRevision &&
    request.scheduledAt === command.scheduledAt &&
    request.room === command.room &&
    request.campus === command.campus &&
    request.mapLink === command.mapLink &&
    request.message === command.message &&
    sameInstant(canonical.scheduledAt, command.scheduledAt) &&
    canonical.room === command.room &&
    canonical.campus === command.campus &&
    canonical.mapLink === command.mapLink &&
    canonical.message === command.message &&
    observation._tag === "InterviewScheduled" &&
    observation.commandId === row.commandId &&
    observation.interviewId === row.interviewId &&
    observation.interviewRevision === row.scheduleRevision &&
    observation.responseState === "Pending" &&
    observation.notificationState === "Pending" &&
    observedSchedule.interviewId === canonical.scheduleInterviewId &&
    observedSchedule.scheduleRevision === canonical.canonicalScheduleRevision &&
    observedSchedule.scheduledAt === command.scheduledAt &&
    observedSchedule.room === canonical.room &&
    observedSchedule.campus === canonical.campus &&
    observedSchedule.mapLink === canonical.mapLink &&
    observedSchedule.message === canonical.message &&
    observedSchedule.scheduledByPersonId === canonical.scheduledByPersonId &&
    sameInstant(observedSchedule.committedAt, canonical.scheduleCommittedAt) &&
    sameInstant(canonical.receiptCommittedAt, canonical.scheduleCommittedAt) &&
    sameInstant(canonical.invitationCreatedAt, canonical.scheduleCommittedAt)
  );
};

const claimInTransaction = (
  sql: DatabaseShape,
  admissions: AdmissionsShape,
  profile: ProfileShape,
  claimId: string,
  claimedAt: string,
): Effect.Effect<ClaimedRecruitmentInvitation | undefined, RecruitmentPersistenceError> =>
  Effect.gen(function* () {
    const rows = yield* sql<ClaimedInvitationRow>`
      WITH candidate AS (
        SELECT outbox.effect_id
        FROM recruitment_invitation_outbox AS outbox
        INNER JOIN recruitment_schedule_command_receipts AS receipt
          ON receipt.command_id = outbox.command_id
        WHERE outbox.status IN ('Pending', 'Failed')
        ORDER BY outbox.attempts ASC, receipt.committed_at ASC,
          outbox.command_id ASC, outbox.ordinal ASC
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT 1
      )
      UPDATE recruitment_invitation_outbox AS outbox
      SET status = 'Processing', claim_id = ${claimId}, claimed_at = ${claimedAt},
        attempts = outbox.attempts + 1, last_failure_tag = NULL
      FROM candidate
      WHERE outbox.effect_id = candidate.effect_id
      RETURNING
        outbox.effect_id AS "effectId",
        outbox.effect_type AS "effectType",
        outbox.command_id AS "commandId",
        outbox.interview_id AS "interviewId",
        outbox.invitation_id AS "invitationId",
        outbox.schedule_revision AS "scheduleRevision",
        outbox.ordinal,
        outbox.claim_id AS "claimId",
        outbox.attempts,
        outbox.payload_json AS "payloadJson"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("claim invitation outbox", cause)),
      ),
    );
    const rawRow = rows[0];
    if (rawRow === undefined) return undefined;
    const decodedRow = yield* decodeForClaim(ClaimedInvitationRowSchema, rawRow);
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
      RecruitmentInvitationOutboxRequestSchema,
      row.payloadJson,
    );
    if (decodedRequest._tag === "Invalid") {
      return yield* quarantineAndSkip(sql, row, "RecruitmentDecodeError");
    }
    const request = decodedRequest.value;

    const canonicalRows = yield* sql<CanonicalInvitationEnvelopeRow>`
      SELECT
        receipt.command_id AS "receiptCommandId",
        receipt.command_sha256 AS "receiptCommandSha256",
        receipt.command_json AS "receiptCommandJson",
        receipt.observation_json AS "receiptObservationJson",
        receipt.interview_id AS "receiptInterviewId",
        receipt.schedule_revision AS "receiptScheduleRevision",
        to_char(
          receipt.committed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "receiptCommittedAt",
        interview.interview_id AS "canonicalInterviewId",
        interview.application_id AS "applicationId",
        interview.interviewer_person_id AS "interviewerPersonId",
        interview.revision AS "interviewRevision",
        schedule.interview_id AS "scheduleInterviewId",
        to_char(
          schedule.scheduled_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "scheduledAt",
        schedule.room,
        schedule.campus,
        schedule.map_link AS "mapLink",
        schedule.message,
        schedule.scheduled_by_person_id AS "scheduledByPersonId",
        to_char(
          schedule.committed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "scheduleCommittedAt",
        schedule.schedule_revision AS "canonicalScheduleRevision",
        invitation.invitation_id AS "canonicalInvitationId",
        invitation.interview_id AS "invitationInterviewId",
        invitation.schedule_revision AS "invitationScheduleRevision",
        invitation.capability_sha256 AS "capabilitySha256",
        invitation.response_state AS "responseState",
        to_char(
          invitation.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "invitationCreatedAt"
      FROM recruitment_invitation_outbox AS outbox
      INNER JOIN recruitment_schedule_command_receipts AS receipt
        ON receipt.command_id = outbox.command_id
      INNER JOIN recruitment_interviews AS interview
        ON interview.interview_id = outbox.interview_id
      INNER JOIN recruitment_interview_schedules AS schedule
        ON schedule.interview_id = outbox.interview_id
      INNER JOIN recruitment_invitations AS invitation
        ON invitation.invitation_id = outbox.invitation_id
      WHERE outbox.effect_id = ${row.effectId}
        AND outbox.status = 'Processing'
        AND outbox.claim_id = ${row.claimId}
      FOR SHARE OF receipt, interview, schedule, invitation
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read canonical invitation envelope", cause)),
      ),
    );
    if (canonicalRows.length !== 1) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const decodedCanonical = yield* decodeForClaim(
      CanonicalInvitationEnvelopeRowSchema,
      canonicalRows[0],
    );
    const decodedCommand = yield* decodeForClaim(
      RecruitmentScheduleCommandSchema,
      canonicalRows[0]?.receiptCommandJson,
    );
    const decodedObservation = yield* decodeForClaim(
      RecruitmentScheduleObservationSchema,
      canonicalRows[0]?.receiptObservationJson,
    );
    if (
      decodedCanonical._tag === "Invalid" ||
      decodedCommand._tag === "Invalid" ||
      decodedObservation._tag === "Invalid" ||
      !canonicalEnvelopeMatches(
        row,
        request,
        decodedCanonical.value,
        decodedCommand.value,
        decodedObservation.value,
      )
    ) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const canonical = decodedCanonical.value;

    const applicantRead = yield* admissions.readApplicantContacts([canonical.applicationId]).pipe(
      Effect.map((contacts) => ({ _tag: "Read" as const, contacts })),
      Effect.catch((failure) =>
        failure._tag === "PublicApplicationPersistenceError"
          ? Effect.fail(persistenceError("read canonical applicant contact", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );
    if (applicantRead._tag === "Missing" || applicantRead.contacts.length !== 1) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const applicant = applicantRead.contacts[0];
    if (applicant === undefined) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const interviewerProfiles = yield* profile.readProfiles([canonical.interviewerPersonId]).pipe(
      Effect.map((profiles) => ({ _tag: "Read" as const, profiles })),
      Effect.catch((failure) =>
        failure._tag === "ProfilePersistenceError"
          ? Effect.fail(persistenceError("read canonical interviewer profile", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );
    if (interviewerProfiles._tag === "Missing" || interviewerProfiles.profiles.length !== 1) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const interviewerProfile = interviewerProfiles.profiles[0];
    if (interviewerProfile === undefined) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const interviewerContacts = yield* profile.readContacts([canonical.interviewerPersonId]).pipe(
      Effect.map((contacts) => ({ _tag: "Read" as const, contacts })),
      Effect.catch((failure) =>
        failure._tag === "ProfilePersistenceError"
          ? Effect.fail(persistenceError("read canonical interviewer contact", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );
    if (interviewerContacts._tag === "Missing" || interviewerContacts.contacts.length !== 1) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    const interviewerContact = interviewerContacts.contacts[0];
    if (interviewerContact === undefined) {
      return yield* quarantineAndSkip(sql, row, "AuthorityEnvelopeMismatch");
    }
    if (
      applicant.applicationId !== canonical.applicationId ||
      request.applicantEmail !== applicant.email ||
      request.applicantPhone !== applicant.phone ||
      interviewerProfile.personId !== canonical.interviewerPersonId ||
      interviewerContact.personId !== canonical.interviewerPersonId ||
      request.interviewerDisplayName !== personProfileDisplayName(interviewerProfile) ||
      request.interviewerEmail !== interviewerContact.email ||
      request.interviewerPhone !== interviewerContact.phone
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

export const claimNextRecruitmentInvitation = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  ClaimedRecruitmentInvitation | undefined,
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
          Effect.fail(persistenceError("invitation outbox claim transaction", cause)),
        ),
      );
  });

export const completeRecruitmentInvitation = (
  claim: ClaimedRecruitmentInvitation,
  evidence: RecruitmentNotificationEvidence,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_outbox
      SET status = 'Delivered', claim_id = NULL, claimed_at = NULL,
        delivered_at = ${evidence.deliveredAt}, last_failure_tag = NULL,
        payload_json = '{}'::jsonb
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("complete invitation outbox claim", cause)),
      ),
    );
    if (rows[0]?.effectId !== claim.effectId) {
      return yield* persistenceError("complete missing invitation outbox claim");
    }
  });

export const failRecruitmentInvitation = (
  claim: ClaimedRecruitmentInvitation,
  failureTag: string,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_outbox
      SET status = 'Failed', claim_id = NULL, claimed_at = NULL,
        last_failure_tag = ${failureTag}
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("fail invitation outbox claim", cause)),
      ),
    );
    if (rows[0]?.effectId !== claim.effectId) {
      return yield* persistenceError("fail missing invitation outbox claim");
    }
  });
export const releaseRecruitmentInvitation = (
  claim: ClaimedRecruitmentInvitation,
): Effect.Effect<void, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    yield* sql`
      UPDATE recruitment_invitation_outbox
      SET status = 'Pending', claim_id = NULL, claimed_at = NULL,
        last_failure_tag = 'InterruptedRecruitmentInvitationClaim'
      WHERE effect_id = ${claim.effectId}
        AND status = 'Processing'
        AND claim_id = ${claim.claimId}
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("release invitation outbox claim", cause)),
      ),
    );
  });

export const recoverStaleRecruitmentInvitations = (
  claimedBefore: string,
): Effect.Effect<number, RecruitmentPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{ readonly effectId: string }>`
      UPDATE recruitment_invitation_outbox
      SET status = 'Failed', claim_id = NULL, claimed_at = NULL,
        last_failure_tag = 'StaleClaimRecovered'
      WHERE status = 'Processing'
        AND claimed_at < ${claimedBefore}
      RETURNING effect_id AS "effectId"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("recover stale invitation claims", cause)),
      ),
    );
    return rows.length;
  });

export const deliverNextRecruitmentInvitation = (
  claimId: string,
  claimedAt: string,
): Effect.Effect<
  RecruitmentInvitationDeliveryResult,
  RecruitmentPersistenceError,
  Admissions | Database | NotificationGateway | Profile
> =>
  Effect.acquireUseRelease(
    claimNextRecruitmentInvitation(claimId, claimedAt),
    (
      claim,
    ): Effect.Effect<
      RecruitmentInvitationDeliveryResult,
      RecruitmentPersistenceError,
      Admissions | Database | NotificationGateway | Profile
    > => {
      if (claim === undefined) return Effect.succeed({ _tag: "Idle" as const });
      return Effect.gen(function* () {
        const gateway = yield* NotificationGateway;
        return yield* gateway.deliverInterviewInvitation(claim.request).pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              failRecruitmentInvitation(claim, failure._tag).pipe(
                Effect.as({ _tag: "Failed" as const, claim, failureTag: failure._tag }),
              ),
            onSuccess: (evidence) =>
              completeRecruitmentInvitation(claim, evidence).pipe(
                Effect.as({ _tag: "Delivered" as const, claim, evidence }),
              ),
          }),
        );
      });
    },
    (claim) => (claim === undefined ? Effect.void : releaseRecruitmentInvitation(claim)),
  );

export const invitationPayloadForEvidence = (request: RecruitmentInvitationOutboxRequest): string =>
  canonicalJson({
    ...request,
    responseCapability: "[REDACTED]",
  });

export type RecruitmentInvitationOutboxFailure =
  | RecruitmentPersistenceError
  | RecruitmentNotificationDeliveryError;
