import { Admissions, type AdmissionsOperations } from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseOperations } from "../service.js";
import { NotificationGateway } from "@vektorprogrammet/domain/notification";
import { Profile, type ProfileOperations } from "@vektorprogrammet/domain/profile";
import { personProfileDisplayName } from "@vektorprogrammet/domain/profile";
import { compareRfc3339Instants } from "@vektorprogrammet/domain/time";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { flow, Data, Predicate, Effect, Schema } from "effect";
import { RecruitmentPersistenceError } from "@vektorprogrammet/domain/recruitment";
import {
  RecruitmentInvitationOutboxRequestSchema,
  type RecruitmentInvitationOutboxRequest,
  type RecruitmentNotificationDeliveryError,
  type RecruitmentNotificationEvidence,
} from "@vektorprogrammet/domain/recruitment";
import {
  RecruitmentInterview,
  RecruitmentInterviewSchedule,
  RecruitmentInvitation,
  RecruitmentScheduleCommandSchema,
  RecruitmentScheduleObservationSchema,
  type RecruitmentScheduleCommand,
  type RecruitmentScheduleObservation,
} from "@vektorprogrammet/domain/recruitment";

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
  readonly envelopeSha256: string | null;
  readonly superseded: boolean;
  readonly staffingRevisionCount: number;
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
  envelopeSha256: Schema.NullOr(Schema.String),
  superseded: Schema.Boolean,
  staffingRevisionCount: Schema.Int,
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

export const RecruitmentInvitationDeliveryResult =
  Data.taggedEnum<RecruitmentInvitationDeliveryResult>();

const persistenceError = (operation: string, cause?: unknown): RecruitmentPersistenceError =>
  new RecruitmentPersistenceError({
    operation,
    cause,
    message: cause instanceof Error ? cause.message : "recruitment outbox persistence failed",
  });

const decodeForClaim = <A>(schema: Schema.ConstraintDecoder<A, never>) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.map((decoded) => ({ _tag: "Decoded" as const, value: decoded })),
    Effect.catch(() => Effect.succeed({ _tag: "Invalid" as const })),
  );

const quarantineClaim = (
  sql: DatabaseOperations,
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
  sql: DatabaseOperations,
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
    (canonical.envelopeSha256 === null
      ? canonical.interviewRevision === row.scheduleRevision
      : canonical.interviewRevision === row.scheduleRevision + canonical.staffingRevisionCount) &&
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
    Predicate.isTagged(observation, "InterviewScheduled") &&
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

const validateEnvelope = (
  sql: DatabaseOperations,
  admissions: AdmissionsOperations,
  profile: ProfileOperations,
  rawRow: ClaimedInvitationRow,
  claimId: string,
  reject: (tag: string) => Effect.Effect<undefined, RecruitmentPersistenceError>,
): Effect.Effect<ClaimedRecruitmentInvitation | undefined, RecruitmentPersistenceError> =>
  Effect.gen(function* () {
    const decodedRow = yield* decodeForClaim(ClaimedInvitationRowSchema)(rawRow);

    if (!Predicate.isTagged(decodedRow, "Decoded")) {
      return yield* reject("RecruitmentDecodeError");
    }

    const row = decodedRow.value;

    if (row.claimId !== claimId) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const decodedRequest = yield* decodeForClaim(RecruitmentInvitationOutboxRequestSchema)(
      row.payloadJson,
    );

    if (!Predicate.isTagged(decodedRequest, "Decoded")) {
      return yield* reject("RecruitmentDecodeError");
    }

    const request = decodedRequest.value;

    const canonicalRows = yield* sql<CanonicalInvitationEnvelopeRow>`
      SELECT
        receipt.envelope_sha256 AS "envelopeSha256",
        invitation.superseded_at IS NOT NULL AS superseded,
        (SELECT count(*)::integer FROM public.recruitment_staffing_history h WHERE h.interview_id=interview.interview_id AND h.revision > receipt.schedule_revision) AS "staffingRevisionCount",
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
        ON schedule.interview_id = outbox.interview_id AND schedule.schedule_revision = outbox.schedule_revision
      INNER JOIN recruitment_invitations AS invitation
        ON invitation.invitation_id = outbox.invitation_id
      WHERE outbox.effect_id = ${row.effectId}
      FOR SHARE OF receipt, interview, schedule, invitation
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read canonical invitation envelope", cause)),
      ),
    );

    if (canonicalRows.length !== 1) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const decodedCanonical = yield* decodeForClaim(CanonicalInvitationEnvelopeRowSchema)(
      canonicalRows[0],
    );

    const decodedCommand = yield* decodeForClaim(RecruitmentScheduleCommandSchema)(
      canonicalRows[0]?.receiptCommandJson,
    );

    if (canonicalRows[0]?.superseded === true) return yield* reject("SupersededRecruitmentInvitation");

    const decodedObservation = yield* decodeForClaim(RecruitmentScheduleObservationSchema)(
      canonicalRows[0]?.receiptObservationJson,
    );

    if (
      !Predicate.isTagged(decodedCanonical, "Decoded") ||
      !Predicate.isTagged(decodedCommand, "Decoded") ||
      !Predicate.isTagged(decodedObservation, "Decoded") ||
      !canonicalEnvelopeMatches(
        row,
        request,
        decodedCanonical.value,
        decodedCommand.value,
        decodedObservation.value,
      )
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
          ? Effect.fail(persistenceError("read canonical applicant contact", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );

    if (Predicate.isTagged(applicantRead, "Missing") || applicantRead.contacts.length !== 1) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const applicant = applicantRead.contacts[0];

    if (applicant === undefined) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const interviewerProfiles = yield* profile.readProfiles([canonical.interviewerPersonId]).pipe(
      Effect.map((profiles) => ({ _tag: "Read" as const, profiles })),
      Effect.catch((failure) =>
        Predicate.isTagged(failure, "ProfilePersistenceError")
          ? Effect.fail(persistenceError("read canonical interviewer profile", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );

    if (
      Predicate.isTagged(interviewerProfiles, "Missing") ||
      interviewerProfiles.profiles.length !== 1
    ) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const interviewerProfile = interviewerProfiles.profiles[0];

    if (interviewerProfile === undefined) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const interviewerContacts = yield* profile.readContacts([canonical.interviewerPersonId]).pipe(
      Effect.map((contacts) => ({ _tag: "Read" as const, contacts })),
      Effect.catch((failure) =>
        Predicate.isTagged(failure, "ProfilePersistenceError")
          ? Effect.fail(persistenceError("read canonical interviewer contact", failure))
          : Effect.succeed({ _tag: "Missing" as const }),
      ),
    );

    if (
      Predicate.isTagged(interviewerContacts, "Missing") ||
      interviewerContacts.contacts.length !== 1
    ) {
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    const interviewerContact = interviewerContacts.contacts[0];

    if (interviewerContact === undefined) {
      return yield* reject("AuthorityEnvelopeMismatch");
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
      return yield* reject("AuthorityEnvelopeMismatch");
    }

    yield* sql`UPDATE public.recruitment_schedule_command_receipts SET envelope_sha256=${envelopeSha256} WHERE command_id=${row.commandId} AND envelope_sha256 IS NULL`.pipe(
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

    return yield* validateEnvelope(sql, admissions, profile, rawRow, claimId, (tag) =>
      quarantineAndSkip(sql, rawRow, tag),
    );
  });

export const sealInterviewInvitationEnvelopes = (interviewId: string) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const admissions = yield* Admissions;
    const profile = yield* Profile;

    const rows =
      yield* sql<ClaimedInvitationRow>`SELECT outbox.effect_id AS "effectId",outbox.effect_type AS "effectType",outbox.command_id AS "commandId",
    outbox.interview_id AS "interviewId",outbox.invitation_id AS "invitationId",outbox.schedule_revision AS "scheduleRevision",outbox.ordinal,
    'legacy-seal'::text AS "claimId",outbox.attempts+1 AS attempts,outbox.payload_json AS "payloadJson"
    FROM public.recruitment_invitation_outbox outbox JOIN public.recruitment_schedule_command_receipts receipt ON receipt.command_id=outbox.command_id
    WHERE outbox.interview_id=${interviewId} AND outbox.status IN ('Pending','Failed','Processing') AND receipt.envelope_sha256 IS NULL
      AND EXISTS (SELECT 1 FROM public.recruitment_invitations invitation
        WHERE invitation.invitation_id=outbox.invitation_id AND invitation.superseded_at IS NULL)
    ORDER BY outbox.effect_id FOR UPDATE OF outbox`;

    for (const row of rows)
      yield* validateEnvelope(sql, admissions, profile, row, "legacy-seal", (tag) =>
        Effect.fail(persistenceError("seal legacy invitation envelope: " + tag)),
      );
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("seal legacy envelopes", cause)),
    ),
  );

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
      if (claim === undefined) return Effect.succeed(RecruitmentInvitationDeliveryResult.Idle());

      return Effect.gen(function* () {
        const gateway = yield* NotificationGateway;

        return yield* gateway.deliverInterviewInvitation(claim.request).pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              failRecruitmentInvitation(claim, failure._tag).pipe(
                Effect.as(
                  RecruitmentInvitationDeliveryResult.Failed({ claim, failureTag: failure._tag }),
                ),
              ),
            onSuccess: (evidence) =>
              completeRecruitmentInvitation(claim, evidence).pipe(
                Effect.as(RecruitmentInvitationDeliveryResult.Delivered({ claim, evidence })),
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
