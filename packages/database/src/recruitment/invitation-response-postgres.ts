import { Admissions, type AdmissionsOperations } from "@vektorprogrammet/domain/admissions";
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { Database, type DatabaseOperations } from "../service.js";
import { Profile, type ProfileOperations } from "@vektorprogrammet/domain/profile";
import { PersonId } from "@vektorprogrammet/domain/organization";
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "@vektorprogrammet/domain/shared-kernel";
import { Match, flow, Predicate, Effect, Schema, SchemaIssue } from "effect";
import {
  RecruitmentInvitationResponseStateSchema,
  RecruitmentInvitationResponseMessageSchema,
  RecruitmentDecodeError,
  RecruitmentInvitationAlreadyResponded,
  RecruitmentInvitationNotFound,
  RecruitmentPersistenceError,
} from "@vektorprogrammet/domain/recruitment";
import { RecruitmentInvitationResponseOutboxRequestSchema } from "@vektorprogrammet/domain/recruitment";
import type { RecruitmentFailure } from "@vektorprogrammet/domain/recruitment";
import {
  RecruitmentInstantSchema,
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationId,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseObservationSchema,
  RecruitmentInvitationResponseResultSchema,
  RecruitmentInterviewId,
  RecruitmentNotificationEffectId,
  type RecruitmentInvitationCapability,
  type RecruitmentInvitationRejectInput,
  type RecruitmentInvitationRequestNewTimeInput,
  type RecruitmentInvitationResponseContext,
  type RecruitmentInvitationResponseMessage,
  type RecruitmentInvitationResponseObservation,
  type RecruitmentInvitationResponseResult,
} from "@vektorprogrammet/domain/recruitment";

type InvitationResponseRow = typeof InvitationResponseRowSchema.Type;

const InvitationResponseRowSchema = Schema.Struct({
  invitationId: RecruitmentInvitationId,
  interviewId: RecruitmentInterviewId,
  applicationId: PublicApplicationIdSchema,
  interviewerPersonId: PersonId,
  interviewRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  scheduleRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  scheduledAt: RecruitmentInstantSchema,
  room: Schema.String,
  campus: Schema.NullOr(Schema.String),
  responseState: RecruitmentInvitationResponseStateSchema,
  responseMessage: Schema.NullOr(Schema.String),
  respondedAt: Schema.NullOr(RecruitmentInstantSchema),
  responseRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

const RecruitmentInvitationResponseContextSchema = Schema.Struct({
  now: RecruitmentInstantSchema,
});

type RecordedResponseState = "Accepted" | "Rejected" | "RequestedNewTime";

const persistenceError = (operation: string, cause?: unknown): RecruitmentPersistenceError =>
  new RecruitmentPersistenceError({
    operation,
    cause,
    message: cause instanceof Error ? cause.message : "recruitment response persistence failed",
  });

const formatIssue = SchemaIssue.makeFormatterDefault();

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, operation: string) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(
      (cause) =>
        new RecruitmentDecodeError({
          message: cause instanceof Error ? cause.message : `invalid ${operation}`,
        }),
    ),
  );

const decodeCapability = flow(
  Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError(() => new RecruitmentInvitationNotFound({})),
);

const readInvitationRow = (
  sql: DatabaseOperations,
  capabilitySha256: string,
): Effect.Effect<InvitationResponseRow | undefined, RecruitmentFailure> =>
  sql<InvitationResponseRow>`
    SELECT
      invitation.invitation_id AS "invitationId",
      invitation.interview_id AS "interviewId",
      interview.application_id AS "applicationId",
      interview.interviewer_person_id AS "interviewerPersonId",
      interview.revision AS "interviewRevision",
      invitation.schedule_revision AS "scheduleRevision",
      to_char(
        schedule.scheduled_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS "scheduledAt",
      schedule.room,
      schedule.campus,
      invitation.response_state AS "responseState",
      invitation.response_message AS "responseMessage",
      CASE WHEN invitation.responded_at IS NULL THEN NULL
        ELSE to_char(
          invitation.responded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      END AS "respondedAt",
      invitation.response_revision AS "responseRevision"
    FROM recruitment_invitations AS invitation
    INNER JOIN recruitment_interviews AS interview
      ON interview.interview_id = invitation.interview_id
    INNER JOIN recruitment_interview_schedules AS schedule
      ON schedule.interview_id = invitation.interview_id
      AND schedule.schedule_revision = invitation.schedule_revision
    WHERE invitation.capability_sha256 = ${capabilitySha256}
      AND invitation.superseded_at IS NULL
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.undefined
        : decode(InvitationResponseRowSchema, "invitation response row")(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read invitation response", cause)),
    ),
  );

const lockInvitationRow = (
  sql: DatabaseOperations,
  capabilitySha256: string,
): Effect.Effect<InvitationResponseRow | undefined, RecruitmentFailure> =>
  sql<InvitationResponseRow>`
    SELECT
      invitation.invitation_id AS "invitationId",
      invitation.interview_id AS "interviewId",
      interview.application_id AS "applicationId",
      interview.interviewer_person_id AS "interviewerPersonId",
      interview.revision AS "interviewRevision",
      invitation.schedule_revision AS "scheduleRevision",
      to_char(
        schedule.scheduled_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS "scheduledAt",
      schedule.room,
      schedule.campus,
      invitation.response_state AS "responseState",
      invitation.response_message AS "responseMessage",
      CASE WHEN invitation.responded_at IS NULL THEN NULL
        ELSE to_char(
          invitation.responded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      END AS "respondedAt",
      invitation.response_revision AS "responseRevision"
    FROM recruitment_invitations AS invitation
    INNER JOIN recruitment_interviews AS interview
      ON interview.interview_id = invitation.interview_id
    INNER JOIN recruitment_interview_schedules AS schedule
      ON schedule.interview_id = invitation.interview_id
      AND schedule.schedule_revision = invitation.schedule_revision
    WHERE invitation.capability_sha256 = ${capabilitySha256}
      AND invitation.superseded_at IS NULL
    FOR UPDATE OF invitation
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.undefined
        : decode(InvitationResponseRowSchema, "locked invitation response row")(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock invitation response", cause)),
    ),
  );

const observationFromRow = (
  row: InvitationResponseRow,
): Effect.Effect<RecruitmentInvitationResponseObservation, RecruitmentDecodeError> =>
  decode(
    RecruitmentInvitationResponseObservationSchema,
    "invitation response observation",
  )({
    scheduledAt: row.scheduledAt,
    room: row.room,
    campus: row.campus,
    responseState: row.responseState,
    responseMessage: row.responseMessage,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new RecruitmentDecodeError({
          message:
            cause instanceof Error ? cause.message : `invalid ${"invitation response observation"}`,
        }),
    ),
  );

const responseContacts = (
  row: InvitationResponseRow,
  admissions: AdmissionsOperations,
  profile: ProfileOperations,
): Effect.Effect<
  {
    readonly applicantDisplayName: string;
    readonly interviewerEmail: string;
    readonly interviewerPhone: string;
  },
  RecruitmentFailure
> =>
  Effect.gen(function* () {
    const applicationId = PublicApplicationIdSchema.make(row.applicationId);

    const applicantRead = yield* admissions
      .readApplicantContacts([applicationId])
      .pipe(
        Effect.mapError((failure) =>
          Predicate.isTagged(failure, "PublicApplicationNotFound")
            ? persistenceError("resolve invitation response applicant", failure)
            : persistenceError("read invitation response applicant", failure),
        ),
      );

    const applicant = applicantRead[0];

    if (applicant === undefined || applicant.applicationId !== applicationId) {
      return yield* persistenceError("resolve invitation response applicant");
    }

    const interviewerPersonId = PersonId.make(row.interviewerPersonId);
    const interviewerRead = yield* profile.readContacts([interviewerPersonId]);
    const interviewer = interviewerRead[0];

    if (interviewer === undefined || interviewer.personId !== interviewerPersonId) {
      return yield* persistenceError("resolve invitation response interviewer");
    }

    return {
      applicantDisplayName: `${applicant.firstName} ${applicant.lastName}`,
      interviewerEmail: interviewer.email,
      interviewerPhone: interviewer.phone,
    };
  });

const recordInvitationResponse = (
  sql: DatabaseOperations,
  admissions: AdmissionsOperations,
  profile: ProfileOperations,
  capabilitySha256: string,
  responseState: RecordedResponseState,
  responseMessage: RecruitmentInvitationResponseMessage | null,
  respondedAt: string,
): Effect.Effect<RecruitmentInvitationResponseResult, RecruitmentFailure> =>
  Effect.gen(function* () {
    const candidate = yield* readInvitationRow(sql, capabilitySha256);

    if (candidate === undefined) return yield* new RecruitmentInvitationNotFound({});
    // Serialize the response with schedule, cancellation, and staffing writers before row locks.
    yield* lockAdvisory(sql, AdvisoryLockKey.recruitmentInterview(candidate.interviewId)).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("lock invitation interview", cause)),
      ),
    );
    const row = yield* lockInvitationRow(sql, capabilitySha256);

    if (row === undefined) return yield* new RecruitmentInvitationNotFound({});

    if (row.responseState !== "Pending" || row.responseRevision !== 0) {
      return yield* new RecruitmentInvitationAlreadyResponded({});
    }

    const notificationRequired = responseState !== "Accepted";

    if (responseState === "RequestedNewTime" && responseMessage === null) {
      return yield* persistenceError("validate invitation new-time response message");
    }

    const contacts = notificationRequired
      ? yield* responseContacts(row, admissions, profile)
      : undefined;

    const updated = yield* sql<{ readonly responseRevision: number }>`
      UPDATE recruitment_invitations
      SET response_state = ${responseState},
        response_message = ${responseMessage},
        responded_at = ${respondedAt},
        response_revision = response_revision + 1
      WHERE invitation_id = ${row.invitationId}
        AND response_state = 'Pending'
        AND response_revision = 0
        AND superseded_at IS NULL
      RETURNING response_revision AS "responseRevision"
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("record invitation response", cause)),
      ),
    );

    const responseRevision = updated[0]?.responseRevision;

    if (responseRevision !== 1) {
      return yield* new RecruitmentInvitationAlreadyResponded({});
    }

    yield* sql`
      INSERT INTO recruitment_invitation_response_audit (
        invitation_id,
        interview_id,
        schedule_revision,
        response_revision,
        response_state,
        response_message,
        responded_at
      ) VALUES (
        ${row.invitationId},
        ${row.interviewId},
        ${row.scheduleRevision},
        ${responseRevision},
        ${responseState},
        ${responseMessage},
        ${respondedAt}
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("write invitation response audit", cause)),
      ),
    );

    if (notificationRequired && contacts !== undefined) {
      const effectId = RecruitmentNotificationEffectId.make(
        `recruitment-invitation-response:${row.invitationId}:${responseRevision}`,
      );

      const requestEffect: ReturnType<
        typeof RecruitmentInvitationResponseOutboxRequestSchema.makeEffect
      > =
        responseState === "Rejected"
          ? RecruitmentInvitationResponseOutboxRequestSchema.members[0].makeEffect({
              effectId,
              invitationId: row.invitationId,
              interviewId: row.interviewId,
              scheduleRevision: row.scheduleRevision,
              responseRevision,
              applicantDisplayName: contacts.applicantDisplayName,
              interviewerEmail: contacts.interviewerEmail,
              interviewerPhone: contacts.interviewerPhone,
              scheduledAt: row.scheduledAt,
              responseState,
              responseMessage,
            })
          : RecruitmentInvitationResponseOutboxRequestSchema.members[1].makeEffect({
              effectId,
              invitationId: row.invitationId,
              interviewId: row.interviewId,
              scheduleRevision: row.scheduleRevision,
              responseRevision,
              applicantDisplayName: contacts.applicantDisplayName,
              interviewerEmail: contacts.interviewerEmail,
              interviewerPhone: contacts.interviewerPhone,
              scheduledAt: row.scheduledAt,
              responseState: "RequestedNewTime",
              responseMessage: yield* decode(
                RecruitmentInvitationResponseMessageSchema,
                "invitation response message",
              )(responseMessage),
            });

      const request = yield* requestEffect.pipe(
        Effect.mapError((issue) => new RecruitmentDecodeError({ message: formatIssue(issue) })),
      );

      yield* sql`UPDATE public.recruitment_invitation_response_audit SET envelope_sha256=${sha256Hex(canonicalJsonBytes(request))} WHERE invitation_id=${row.invitationId} AND response_revision=${responseRevision} AND envelope_sha256 IS NULL`.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("record response envelope provenance", cause)),
        ),
      );

      yield* sql`
        INSERT INTO recruitment_invitation_response_outbox (
          effect_id,
          effect_type,
          invitation_id,
          interview_id,
          schedule_revision,
          response_revision,
          response_state,
          response_message,
          ordinal,
          payload_json
        ) VALUES (
          ${request.effectId},
          ${request._tag},
          ${request.invitationId},
          ${request.interviewId},
          ${request.scheduleRevision},
          ${request.responseRevision},
          ${request.responseState},
          ${request.responseMessage},
          0,
          ${canonicalJson(request)}::jsonb
        )
      `.pipe(
        Effect.asVoid,
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("write invitation response outbox", cause)),
        ),
      );
    }

    const fields = {
      interviewRevision: row.interviewRevision,
      scheduleRevision: row.scheduleRevision,
      responseRevision,
      respondedAt,
    };

    const responseEffect = Match.value(responseState).pipe(
      Match.when("Accepted", (responseState) =>
        decode(
          Schema.Null,
          "accepted invitation response message",
        )(responseMessage).pipe(
          Effect.flatMap((responseMessage) =>
            RecruitmentInvitationResponseResultSchema.members[0].makeEffect({
              ...fields,
              responseState,
              responseMessage,
              notificationState: "NotRequired",
            }),
          ),
        ),
      ),
      Match.when("Rejected", (responseState) =>
        RecruitmentInvitationResponseResultSchema.members[1].makeEffect({
          ...fields,
          responseState,
          responseMessage,
          notificationState: "Pending",
        }),
      ),
      Match.when("RequestedNewTime", (responseState) =>
        decode(
          RecruitmentInvitationResponseMessageSchema,
          "invitation response message",
        )(responseMessage).pipe(
          Effect.flatMap((responseMessage) =>
            RecruitmentInvitationResponseResultSchema.members[2].makeEffect({
              ...fields,
              responseState,
              responseMessage,
              notificationState: "Pending",
            }),
          ),
        ),
      ),
      Match.exhaustive,
    );

    return yield* responseEffect.pipe(
      Effect.mapError(
        (cause) =>
          new RecruitmentDecodeError({
            message: SchemaIssue.isIssue(cause) ? formatIssue(cause) : String(cause),
          }),
      ),
    );
  });

const transitionInvitation = (
  capability: RecruitmentInvitationCapability,
  responseState: RecordedResponseState,
  responseMessage: RecruitmentInvitationResponseMessage | null,
  context: RecruitmentInvitationResponseContext,
): Effect.Effect<
  RecruitmentInvitationResponseResult,
  RecruitmentFailure,
  Admissions | Database | Profile
> =>
  Effect.gen(function* () {
    const decodedCapability = yield* decodeCapability(capability);

    const decodedContext = yield* decode(
      RecruitmentInvitationResponseContextSchema,
      "invitation response context",
    )(context);

    const sql = yield* Database;
    const admissions = yield* Admissions;
    const profile = yield* Profile;
    const capabilitySha256 = sha256Hex(new TextEncoder().encode(decodedCapability));

    return yield* sql
      .withTransaction(
        recordInvitationResponse(
          sql,
          admissions,
          profile,
          capabilitySha256,
          responseState,
          responseMessage,
          decodedContext.now,
        ),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("invitation response transaction", cause)),
        ),
      );
  });

export const readInvitationResponse = (
  capability: RecruitmentInvitationCapability,
): Effect.Effect<RecruitmentInvitationResponseObservation, RecruitmentFailure, Database> =>
  Effect.gen(function* () {
    const decodedCapability = yield* decodeCapability(capability);
    const sql = yield* Database;
    const capabilitySha256 = sha256Hex(new TextEncoder().encode(decodedCapability));
    const row = yield* readInvitationRow(sql, capabilitySha256);

    if (row === undefined) return yield* new RecruitmentInvitationNotFound({});

    return yield* observationFromRow(row);
  });

export const confirmInvitation = (
  capability: RecruitmentInvitationCapability,
  context: RecruitmentInvitationResponseContext,
): Effect.Effect<
  RecruitmentInvitationResponseResult,
  RecruitmentFailure,
  Admissions | Database | Profile
> => transitionInvitation(capability, "Accepted", null, context);

export const rejectInvitation = (
  capability: RecruitmentInvitationCapability,
  input: RecruitmentInvitationRejectInput,
  context: RecruitmentInvitationResponseContext,
): Effect.Effect<
  RecruitmentInvitationResponseResult,
  RecruitmentFailure,
  Admissions | Database | Profile
> =>
  Effect.gen(function* () {
    const decodedInput = yield* decode(
      RecruitmentInvitationRejectInputSchema,
      "invitation rejection",
    )(input);

    return yield* transitionInvitation(
      capability,
      "Rejected",
      decodedInput.message ?? null,
      context,
    );
  });

export const requestNewInvitationTime = (
  capability: RecruitmentInvitationCapability,
  input: RecruitmentInvitationRequestNewTimeInput,
  context: RecruitmentInvitationResponseContext,
): Effect.Effect<
  RecruitmentInvitationResponseResult,
  RecruitmentFailure,
  Admissions | Database | Profile
> =>
  Effect.gen(function* () {
    const decodedInput = yield* decode(
      RecruitmentInvitationRequestNewTimeInputSchema,
      "invitation new-time request",
    )(input);

    return yield* transitionInvitation(
      capability,
      "RequestedNewTime",
      decodedInput.message,
      context,
    );
  });
