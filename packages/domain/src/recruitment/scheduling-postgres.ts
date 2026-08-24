import { Admissions, type AdmissionsShape } from "../admissions/service.js";
import { ADMISSIONS_APPLICANT_CONTACT_READ_LIMIT } from "../application/postgres.js";
import {
  PublicApplicationIdSchema,
  type ApplicantContactProjection,
} from "../application/schema.js";
import { Database, type DatabaseShape } from "../database/service.js";
import { Organization, type OrganizationShape } from "../organization/service.js";
import { DepartmentId, PersonId, type Membership } from "../organization/schema.js";
import { PROFILE_READ_LIMIT } from "../profile/postgres.js";
import { Profile, type ProfileShape } from "../profile/service.js";
import {
  personProfileDisplayName,
  type PersonContactProfile,
  type PersonProfile,
} from "../profile/schema.js";
import { compareRfc3339Instants } from "../time.js";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { Effect, Schema } from "effect";
import {
  RecruitmentApplicationNotFound,
  RecruitmentDecodeError,
  RecruitmentInactiveActor,
  RecruitmentInterviewAlreadyScheduled,
  RecruitmentInterviewNotFound,
  RecruitmentInterviewStaleRevision,
  RecruitmentInvalidContext,
  RecruitmentPersistenceError,
  RecruitmentRoleDenied,
  RecruitmentScheduleCommandConflict,
  RecruitmentScheduleInPast,
  RecruitmentScopeDenied,
} from "./errors.js";
import {
  RecruitmentInvitationOutboxRequestSchema,
  type RecruitmentInvitationOutboxRequest,
} from "./effects.js";
import type { RecruitmentFailure } from "./service.js";
import {
  RecruitmentActorSchema,
  RecruitmentInterviewSchedule,
  RecruitmentInvitationId,
  RecruitmentNotificationEffectId,
  RecruitmentScheduleCommandSchema,
  RecruitmentScheduleObservationSchema,
  RecruitmentScheduleResultSchema,
  RecruitmentSchedulingBoardSchema,
  RecruitmentSchedulingInterviewSchema,
  isRecruitmentNow,
  type RecruitmentActor,
  type RecruitmentInterviewScheduleValue,
  type RecruitmentReadSchedulingBoardContext,
  type RecruitmentScheduleCommand,
  type RecruitmentScheduleContext,
  type RecruitmentScheduleObservation,
  type RecruitmentScheduleResult,
  type RecruitmentSchedulingBoard,
  type RecruitmentSchedulingInterview,
} from "./schema.js";

type DepartmentActor = Extract<RecruitmentActor, { readonly _tag: "DepartmentLeader" | "Member" }>;

interface SchedulingBoardRow {
  readonly interviewId: string;
  readonly applicationId: string;
  readonly departmentId: string;
  readonly interviewerPersonId: string;
  readonly revision: number;
  readonly scheduledAt: string | null;
  readonly room: string | null;
  readonly campus: string | null;
  readonly mapLink: string | null;
  readonly message: string | null;
  readonly scheduledByPersonId: string | null;
  readonly committedAt: string | null;
  readonly scheduleRevision: number | null;
  readonly responseState: string | null;
  readonly notificationState: string | null;
}

interface SchedulingInterviewRow {
  readonly interviewId: string;
  readonly applicationId: string;
  readonly departmentId: string;
  readonly interviewerPersonId: string;
  readonly revision: number;
}

interface StoredScheduleReceiptRow {
  readonly commandSha256: string;
  readonly interviewId: string;
  readonly scheduleRevision: number;
  readonly observationJson: unknown;
}

const SchedulingBoardRowSchema = Schema.Struct({
  interviewId: Schema.String,
  applicationId: Schema.String,
  departmentId: Schema.String,
  interviewerPersonId: Schema.String,
  revision: Schema.Number,
  scheduledAt: Schema.NullOr(Schema.String),
  room: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
  mapLink: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  scheduledByPersonId: Schema.NullOr(Schema.String),
  committedAt: Schema.NullOr(Schema.String),
  scheduleRevision: Schema.NullOr(Schema.Number),
  responseState: Schema.NullOr(Schema.String),
  notificationState: Schema.NullOr(Schema.String),
});

const SchedulingInterviewRowSchema = Schema.Struct({
  interviewId: Schema.String,
  applicationId: Schema.String,
  departmentId: Schema.String,
  interviewerPersonId: Schema.String,
  revision: Schema.Number,
});

const StoredScheduleReceiptRowSchema = Schema.Struct({
  commandSha256: Schema.String,
  interviewId: Schema.String,
  scheduleRevision: Schema.Number,
  observationJson: Schema.Unknown,
});

const persistenceError = (operation: string, cause?: unknown): RecruitmentPersistenceError =>
  new RecruitmentPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : "recruitment persistence failed",
  });
const readApplicantContacts = (
  admissions: AdmissionsShape,
  applicationIds: ReadonlyArray<typeof PublicApplicationIdSchema.Type>,
): Effect.Effect<ReadonlyArray<ApplicantContactProjection>, RecruitmentFailure> =>
  admissions
    .readApplicantContacts(applicationIds)
    .pipe(
      Effect.mapError((failure) =>
        failure._tag === "PublicApplicationNotFound"
          ? new RecruitmentApplicationNotFound({ applicationId: failure.applicationId })
          : persistenceError("read Admissions applicant contacts", failure),
      ),
    );

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new RecruitmentDecodeError({
          message: cause instanceof Error ? cause.message : `invalid ${operation}`,
        }),
    ),
  );

const membershipActiveAt = (membership: Membership, now: string): boolean =>
  compareRfc3339Instants(membership.startAt, now) <= 0 &&
  (membership.endAt === null || compareRfc3339Instants(now, membership.endAt) < 0) &&
  !membership.isSuspended;

const memberHasActiveDepartmentMembership = (
  actor: Extract<RecruitmentActor, { readonly _tag: "Member" }>,
  now: string,
  organization: OrganizationShape,
): Effect.Effect<boolean, RecruitmentFailure> =>
  Effect.gen(function* () {
    const teams = yield* organization.listTeams(actor.departmentId);
    for (const team of teams) {
      if (!team.active) continue;
      const memberships = yield* organization.listMembershipsForTeam(team.teamId);
      if (
        memberships.some(
          (membership) =>
            membership.personId === actor.personId && membershipActiveAt(membership, now),
        )
      ) {
        return true;
      }
    }
    return false;
  });

const authorizeActor = (
  actor: RecruitmentActor,
  now: string,
  organization: OrganizationShape,
): Effect.Effect<DepartmentActor, RecruitmentFailure> =>
  Effect.gen(function* () {
    if (!isRecruitmentNow(now)) {
      return yield* new RecruitmentInvalidContext({ message: "invalid scheduling instant" });
    }
    if (!actor.active) return yield* new RecruitmentInactiveActor({ personId: actor.personId });
    if (actor._tag === "GlobalAdmin") {
      return yield* new RecruitmentRoleDenied({ personId: actor.personId });
    }
    if (actor._tag === "Member") {
      const active = yield* memberHasActiveDepartmentMembership(actor, now, organization);
      if (!active) return yield* new RecruitmentInactiveActor({ personId: actor.personId });
    }
    return actor;
  });

const readSchedulingRows = (
  sql: DatabaseShape,
  actor: DepartmentActor,
): Effect.Effect<ReadonlyArray<SchedulingBoardRow>, RecruitmentFailure> =>
  sql<SchedulingBoardRow>`
    SELECT
      i.interview_id AS "interviewId",
      i.application_id AS "applicationId",
      i.department_id AS "departmentId",
      i.interviewer_person_id AS "interviewerPersonId",
      i.revision,
      CASE WHEN s.scheduled_at IS NULL THEN NULL
        ELSE to_char(s.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS "scheduledAt",
      s.room,
      s.campus,
      s.map_link AS "mapLink",
      s.message,
      s.scheduled_by_person_id AS "scheduledByPersonId",
      CASE WHEN s.committed_at IS NULL THEN NULL
        ELSE to_char(s.committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS "committedAt",
      s.schedule_revision AS "scheduleRevision",
      invitation.response_state AS "responseState",
      outbox.status AS "notificationState"
    FROM recruitment_interviews i
    LEFT JOIN recruitment_interview_schedules s ON s.interview_id = i.interview_id
    LEFT JOIN recruitment_invitations invitation ON invitation.interview_id = i.interview_id
    LEFT JOIN recruitment_invitation_outbox outbox ON outbox.invitation_id = invitation.invitation_id
    WHERE i.department_id = ${actor.departmentId}
      AND (${actor._tag === "DepartmentLeader"} OR i.interviewer_person_id = ${actor.personId})
    ORDER BY i.assigned_at ASC, i.interview_id ASC
  `.pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read scheduling board", cause)),
    ),
  );

const scheduleFromRow = (
  row: SchedulingBoardRow,
): Effect.Effect<RecruitmentInterviewScheduleValue | null, RecruitmentFailure> => {
  if (row.scheduledAt === null) {
    if (
      row.room !== null ||
      row.campus !== null ||
      row.mapLink !== null ||
      row.message !== null ||
      row.scheduledByPersonId !== null ||
      row.committedAt !== null ||
      row.scheduleRevision !== null
    ) {
      return Effect.fail(persistenceError("validate partial schedule row"));
    }
    return Effect.succeed(null);
  }
  if (
    row.room === null ||
    row.message === null ||
    row.scheduledByPersonId === null ||
    row.committedAt === null ||
    row.scheduleRevision === null
  ) {
    return Effect.fail(persistenceError("validate incomplete schedule row"));
  }
  return decode(
    RecruitmentInterviewSchedule,
    {
      interviewId: row.interviewId,
      scheduledAt: row.scheduledAt,
      room: row.room,
      campus: row.campus,
      mapLink: row.mapLink,
      message: row.message,
      scheduledByPersonId: row.scheduledByPersonId,
      committedAt: row.committedAt,
      scheduleRevision: row.scheduleRevision,
    },
    "scheduling board schedule",
  );
};

const schedulingBoard = (
  context: RecruitmentReadSchedulingBoardContext,
  sql: DatabaseShape,
  admissions: AdmissionsShape,
  organization: OrganizationShape,
  profile: ProfileShape,
): Effect.Effect<RecruitmentSchedulingBoard, RecruitmentFailure> =>
  Effect.gen(function* () {
    const actor = yield* authorizeActor(context.actor, context.now, organization);
    const rows = yield* readSchedulingRows(sql, actor);
    const interviewerIds = [...new Set(rows.map((row) => row.interviewerPersonId))].map((value) =>
      PersonId.make(value),
    );
    const applicationIds = [...new Set(rows.map((row) => row.applicationId))].map((value) =>
      PublicApplicationIdSchema.make(value),
    );
    const applicantContactByApplicationId = new Map<string, ApplicantContactProjection>();
    for (
      let offset = 0;
      offset < applicationIds.length;
      offset += ADMISSIONS_APPLICANT_CONTACT_READ_LIMIT
    ) {
      const batch = applicationIds.slice(offset, offset + ADMISSIONS_APPLICANT_CONTACT_READ_LIMIT);
      for (const value of yield* readApplicantContacts(admissions, batch)) {
        applicantContactByApplicationId.set(String(value.applicationId), value);
      }
    }
    const profileById = new Map<string, PersonProfile>();
    const contactById = new Map<string, PersonContactProfile>();
    for (let offset = 0; offset < interviewerIds.length; offset += PROFILE_READ_LIMIT) {
      const batch = interviewerIds.slice(offset, offset + PROFILE_READ_LIMIT);
      for (const value of yield* profile.readProfiles(batch)) {
        profileById.set(String(value.personId), value);
      }
      for (const value of yield* profile.readContacts(batch)) {
        contactById.set(String(value.personId), value);
      }
    }
    const interviews: RecruitmentSchedulingInterview[] = [];
    for (const rawRow of rows) {
      const row = yield* decode(SchedulingBoardRowSchema, rawRow, "scheduling board row");
      const interviewerProfile = profileById.get(row.interviewerPersonId);
      const interviewerContact = contactById.get(row.interviewerPersonId);
      const applicantContact = applicantContactByApplicationId.get(row.applicationId);
      if (
        interviewerProfile === undefined ||
        interviewerContact === undefined ||
        applicantContact === undefined
      ) {
        return yield* persistenceError("resolve scheduling board authorities");
      }
      const schedule = yield* scheduleFromRow(row);
      interviews.push(
        yield* decode(
          RecruitmentSchedulingInterviewSchema,
          {
            interviewId: row.interviewId,
            applicationId: row.applicationId,
            departmentId: row.departmentId,
            interviewer: {
              personId: row.interviewerPersonId,
              displayName: personProfileDisplayName(interviewerProfile),
              email: interviewerContact.email,
              phone: interviewerContact.phone,
            },
            applicant: applicantContact,
            revision: row.revision,
            schedule,
            responseState: row.responseState,
            notificationState: row.notificationState,
          },
          "scheduling interview observation",
        ),
      );
    }
    return yield* decode(
      RecruitmentSchedulingBoardSchema,
      { departmentId: actor.departmentId, interviews },
      "scheduling board observation",
    );
  });

const readSchedulingInterview = (
  sql: DatabaseShape,
  interviewId: string,
): Effect.Effect<SchedulingInterviewRow | undefined, RecruitmentFailure> =>
  sql<SchedulingInterviewRow>`
    SELECT
      i.interview_id AS "interviewId",
      i.application_id AS "applicationId",
      i.department_id AS "departmentId",
      i.interviewer_person_id AS "interviewerPersonId",
      i.revision
    FROM recruitment_interviews i
    WHERE i.interview_id = ${interviewId}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(SchedulingInterviewRowSchema, rows[0], "scheduling interview row"),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock scheduling interview", cause)),
    ),
  );

const readStoredScheduleReceipt = (
  sql: DatabaseShape,
  commandId: string,
): Effect.Effect<StoredScheduleReceiptRow | undefined, RecruitmentFailure> =>
  sql<StoredScheduleReceiptRow>`
    SELECT
      command_sha256 AS "commandSha256",
      interview_id AS "interviewId",
      schedule_revision AS "scheduleRevision",
      observation_json AS "observationJson"
    FROM recruitment_schedule_command_receipts
    WHERE command_id = ${commandId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(StoredScheduleReceiptRowSchema, rows[0], "schedule command receipt"),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read schedule command receipt", cause)),
    ),
  );

const interviewAlreadyScheduled = (
  sql: DatabaseShape,
  interviewId: string,
): Effect.Effect<boolean, RecruitmentFailure> =>
  sql<{ readonly exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM recruitment_interview_schedules WHERE interview_id = ${interviewId}
    ) AS "exists"
  `.pipe(
    Effect.map((rows) => rows[0]?.exists === true),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read existing interview schedule", cause)),
    ),
  );

const capabilityIsValid = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/u.test(value);

const writeScheduleRows = (
  sql: DatabaseShape,
  command: RecruitmentScheduleCommand,
  context: RecruitmentScheduleContext & { readonly actor: DepartmentActor },
  interview: SchedulingInterviewRow,
  applicantContact: ApplicantContactProjection,
  interviewerDisplayName: string,
  interviewerEmail: string,
  interviewerPhone: string,
  digest: string,
): Effect.Effect<RecruitmentScheduleObservation, RecruitmentFailure> =>
  Effect.gen(function* () {
    const scheduleRevision = interview.revision + 1;
    const updated = yield* sql<{ readonly revision: number }>`
      UPDATE recruitment_interviews
      SET revision = revision + 1
      WHERE interview_id = ${command.interviewId}
        AND revision = ${command.expectedRevision}
      RETURNING revision
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("revise scheduled interview", cause)),
      ),
    );
    if (updated[0]?.revision !== scheduleRevision) {
      return yield* new RecruitmentInterviewStaleRevision({
        interviewId: command.interviewId,
        expectedRevision: command.expectedRevision,
        actualRevision: interview.revision,
      });
    }
    const schedule = yield* decode(
      RecruitmentInterviewSchedule,
      {
        interviewId: command.interviewId,
        scheduledAt: command.scheduledAt,
        room: command.room,
        campus: command.campus,
        mapLink: command.mapLink,
        message: command.message,
        scheduledByPersonId: context.actor.personId,
        committedAt: context.now,
        scheduleRevision,
      },
      "stored interview schedule",
    );
    yield* sql`
      INSERT INTO recruitment_interview_schedules (
        interview_id, scheduled_at, room, campus, map_link, message,
        scheduled_by_person_id, committed_at, schedule_revision
      ) VALUES (
        ${schedule.interviewId}, ${schedule.scheduledAt}, ${schedule.room}, ${schedule.campus},
        ${schedule.mapLink}, ${schedule.message}, ${schedule.scheduledByPersonId},
        ${schedule.committedAt}, ${schedule.scheduleRevision}
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("write interview schedule", cause)),
      ),
    );
    const capabilitySha256 = sha256Hex(new TextEncoder().encode(context.responseCapability));
    yield* sql`
      INSERT INTO recruitment_invitations (
        invitation_id, interview_id, schedule_revision, capability_sha256, response_state, created_at
      ) VALUES (
        ${context.invitationId}, ${command.interviewId}, ${scheduleRevision},
        ${capabilitySha256}, 'Pending', ${context.now}
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("write recruitment invitation", cause)),
      ),
    );
    const observation = yield* decode(
      RecruitmentScheduleObservationSchema,
      {
        _tag: "InterviewScheduled",
        commandId: command.commandId,
        interviewId: command.interviewId,
        schedule,
        interviewRevision: scheduleRevision,
        responseState: "Pending",
        notificationState: "Pending",
      },
      "schedule observation",
    );
    yield* sql`
      INSERT INTO recruitment_schedule_command_receipts (
        command_id, command_sha256, command_json, observation_json,
        interview_id, schedule_revision, committed_at
      ) VALUES (
        ${command.commandId}, ${digest}, ${canonicalJson(command)}::jsonb,
        ${canonicalJson(observation)}::jsonb, ${command.interviewId},
        ${scheduleRevision}, ${context.now}
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("write schedule command receipt", cause)),
      ),
    );
    yield* sql`
      INSERT INTO recruitment_schedule_audit (
        command_id, interview_id, schedule_revision, actor_person_id, action, occurred_at
      ) VALUES (
        ${command.commandId}, ${command.interviewId}, ${scheduleRevision},
        ${context.actor.personId}, 'InterviewScheduled', ${context.now}
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("write schedule audit", cause)),
      ),
    );
    const effectId = RecruitmentNotificationEffectId.make(`recruitment-invitation:${digest}`);
    const request: RecruitmentInvitationOutboxRequest = yield* decode(
      RecruitmentInvitationOutboxRequestSchema,
      {
        _tag: "SendInterviewInvitation",
        effectId,
        commandId: command.commandId,
        interviewId: command.interviewId,
        invitationId: context.invitationId,
        scheduleRevision,
        applicantEmail: applicantContact.email,
        applicantPhone: applicantContact.phone,
        interviewerDisplayName,
        interviewerEmail,
        interviewerPhone,
        scheduledAt: command.scheduledAt,
        room: command.room,
        campus: command.campus,
        mapLink: command.mapLink,
        message: command.message,
        responseCapability: context.responseCapability,
      },
      "invitation notification request",
    );
    yield* sql`
      INSERT INTO recruitment_invitation_outbox (
        effect_id, effect_type, command_id, interview_id, invitation_id,
        schedule_revision, ordinal, payload_json
      ) VALUES (
        ${request.effectId}, ${request._tag}, ${request.commandId}, ${request.interviewId},
        ${request.invitationId}, ${request.scheduleRevision}, 0,
        ${canonicalJson(request)}::jsonb
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("write invitation outbox", cause)),
      ),
    );
    return observation;
  });

const scheduleInTransaction = (
  command: RecruitmentScheduleCommand,
  context: RecruitmentScheduleContext,
  sql: DatabaseShape,
  admissions: AdmissionsShape,
  organization: OrganizationShape,
  profile: ProfileShape,
  digest: string,
): Effect.Effect<RecruitmentScheduleResult, RecruitmentFailure> =>
  Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("lock schedule command", cause)),
      ),
    );
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.interviewId}, 0))`.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("lock scheduled interview", cause)),
      ),
    );
    const interview = yield* readSchedulingInterview(sql, command.interviewId);
    if (interview === undefined) {
      return yield* new RecruitmentInterviewNotFound({ interviewId: command.interviewId });
    }
    const actor = yield* authorizeActor(context.actor, context.now, organization);
    if (interview.departmentId !== actor.departmentId) {
      return yield* new RecruitmentScopeDenied({
        personId: actor.personId,
        departmentId: DepartmentId.make(interview.departmentId),
      });
    }
    if (actor._tag === "Member" && interview.interviewerPersonId !== actor.personId) {
      return yield* new RecruitmentScopeDenied({
        personId: actor.personId,
        departmentId: actor.departmentId,
      });
    }
    const storedReceipt = yield* readStoredScheduleReceipt(sql, command.commandId);
    if (storedReceipt !== undefined) {
      if (storedReceipt.commandSha256 !== digest) {
        return yield* new RecruitmentScheduleCommandConflict({ commandId: command.commandId });
      }
      if (storedReceipt.interviewId !== command.interviewId) {
        return yield* persistenceError("validate schedule receipt interview linkage");
      }
      const observation = yield* decode(
        RecruitmentScheduleObservationSchema,
        storedReceipt.observationJson,
        "stored schedule observation",
      );
      if (
        observation.interviewId !== storedReceipt.interviewId ||
        observation.interviewRevision !== storedReceipt.scheduleRevision
      ) {
        return yield* persistenceError("validate schedule receipt observation linkage");
      }
      return yield* decode(
        RecruitmentScheduleResultSchema,
        { observation, replayed: true },
        "schedule replay result",
      );
    }
    if (interview.revision !== command.expectedRevision) {
      return yield* new RecruitmentInterviewStaleRevision({
        interviewId: command.interviewId,
        expectedRevision: command.expectedRevision,
        actualRevision: interview.revision,
      });
    }
    if (yield* interviewAlreadyScheduled(sql, command.interviewId)) {
      return yield* new RecruitmentInterviewAlreadyScheduled({ interviewId: command.interviewId });
    }
    if (compareRfc3339Instants(command.scheduledAt, context.now) <= 0) {
      return yield* new RecruitmentScheduleInPast({ interviewId: command.interviewId });
    }
    const [applicantContact] = yield* readApplicantContacts(admissions, [
      PublicApplicationIdSchema.make(interview.applicationId),
    ]);
    if (applicantContact === undefined) {
      return yield* persistenceError("resolve scheduled applicant contact");
    }
    const [interviewerProfile] = yield* profile.readProfiles([
      PersonId.make(interview.interviewerPersonId),
    ]);
    const [interviewerContact] = yield* profile.readContacts([
      PersonId.make(interview.interviewerPersonId),
    ]);
    if (interviewerProfile === undefined || interviewerContact === undefined) {
      return yield* persistenceError("resolve scheduled interviewer contact");
    }
    const observation = yield* writeScheduleRows(
      sql,
      command,
      { ...context, actor },
      interview,
      applicantContact,
      personProfileDisplayName(interviewerProfile),
      interviewerContact.email,
      interviewerContact.phone,
      digest,
    );
    return yield* decode(
      RecruitmentScheduleResultSchema,
      { observation, replayed: false },
      "schedule result",
    );
  });

export const readSchedulingBoard = (
  context: RecruitmentReadSchedulingBoardContext,
): Effect.Effect<
  RecruitmentSchedulingBoard,
  RecruitmentFailure,
  Database | Admissions | Organization | Profile
> =>
  Effect.gen(function* () {
    const actor = yield* decode(RecruitmentActorSchema, context.actor, "recruitment actor");
    const sql = yield* Database;
    const admissions = yield* Admissions;
    const organization = yield* Organization;
    const profile = yield* Profile;
    return yield* schedulingBoard(
      { actor, now: context.now },
      sql,
      admissions,
      organization,
      profile,
    );
  });

export const scheduleInterview = (
  command: RecruitmentScheduleCommand,
  context: RecruitmentScheduleContext,
): Effect.Effect<
  RecruitmentScheduleResult,
  RecruitmentFailure,
  Database | Admissions | Organization | Profile
> =>
  Effect.gen(function* () {
    const decodedCommand = yield* decode(
      RecruitmentScheduleCommandSchema,
      command,
      "schedule command",
    );
    const actor = yield* decode(RecruitmentActorSchema, context.actor, "recruitment actor");
    const invitationId = yield* decode(
      RecruitmentInvitationId,
      context.invitationId,
      "invitation identity",
    );
    if (!capabilityIsValid(context.responseCapability)) {
      return yield* new RecruitmentInvalidContext({ message: "invalid response capability" });
    }
    const sql = yield* Database;
    const admissions = yield* Admissions;
    const organization = yield* Organization;
    const profile = yield* Profile;
    const digest = sha256Hex(canonicalJsonBytes(decodedCommand));
    return yield* sql
      .withTransaction(
        scheduleInTransaction(
          decodedCommand,
          {
            actor,
            now: context.now,
            invitationId,
            responseCapability: context.responseCapability,
          },
          sql,
          admissions,
          organization,
          profile,
          digest,
        ),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("schedule transaction", cause)),
        ),
      );
  });
