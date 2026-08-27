import { Admissions, type AdmissionsShape } from "../admissions/service.js";
import { Database, type DatabaseShape } from "../database/service.js";
import { Organization, type OrganizationShape } from "../organization/service.js";
import { PersonId } from "../organization/schema.js";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { Effect, Schema } from "effect";
import {
  RecruitmentConductValidationError,
  RecruitmentInterviewNotFound,
  RecruitmentInterviewNotScheduled,
  RecruitmentInvitationNotAccepted,
  RecruitmentLifecycleCommandConflict,
  RecruitmentPersistenceError,
  RecruitmentScopeDenied,
  RecruitmentInterviewStaleRevision,
} from "./errors.js";
import {
  cancelInterview as applyCancellation,
  finalizeInterview as applyFinalization,
} from "./conduct.js";
import {
  CancelInterviewCommandSchema,
  CancelInterviewObservationSchema,
  CancelInterviewResultSchema,
  FinalizeInterviewCommandSchema,
  FinalizeInterviewObservationSchema,
  FinalizeInterviewResultSchema,
  RecruitmentConductActorSchema,
  RecruitmentInterviewCancellation,
  RecruitmentInterviewConduct,
  RecruitmentInterviewQuestionSnapshot,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterview,
  RecruitmentInterviewSchedule,
  RecruitmentInvitationResponseStateSchema,
  RecruitmentActorSchema,
  type CancelInterviewCommand,
  type CancelInterviewResult,
  RecruitmentInterviewId,
  type FinalizeInterviewCommand,
  type FinalizeInterviewResult,
  type RecruitmentConductContext,
  type RecruitmentConductState,
  type RecruitmentInterviewConductObservation,
  type RecruitmentInterviewQuestionSnapshotValue,
} from "./schema.js";
import type { RecruitmentFailure } from "./service.js";

interface InterviewRow {
  readonly interviewId: string;
  readonly applicationId: string;
  readonly departmentId: string;
  readonly interviewerPersonId: string;
  readonly interviewSchemaId: string;
  readonly assignedByPersonId: string;
  readonly assignedAt: string;
  readonly revision: number;
}
interface ScheduleRow {
  readonly interviewId: string;
  readonly scheduledAt: string;
  readonly room: string;
  readonly campus: string | null;
  readonly mapLink: string | null;
  readonly message: string;
  readonly scheduledByPersonId: string;
  readonly committedAt: string;
  readonly scheduleRevision: number;
}
interface InvitationRow {
  readonly responseState: string;
}
interface ReceiptRow {
  readonly commandSha256: string;
  readonly interviewId: string;
  readonly kind: string;
  readonly resultingRevision: number;
  readonly observationJson: unknown;
}
interface ConductRow {
  readonly answers: unknown;
  readonly explanatoryPower: number;
  readonly roleModel: number;
  readonly suitability: number;
  readonly finalizedByPersonId: string;
  readonly finalizedAt: string;
  readonly interviewRevision: number;
}
interface CancellationRow {
  readonly cancelledByPersonId: string;
  readonly cancelledAt: string;
  readonly interviewRevision: number;
}

const persistenceError = (operation: string, cause?: unknown) =>
  new RecruitmentPersistenceError({
    operation,
    message:
      cause instanceof Error ? cause.message : String(cause ?? "recruitment persistence failed"),
  });

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new RecruitmentPersistenceError({
          operation: `decode ${operation}`,
          message: String(cause),
        }),
    ),
  );

const readInterview = (sql: DatabaseShape, interviewId: string, lock: boolean) =>
  sql<InterviewRow>`
    SELECT interview_id AS "interviewId", application_id AS "applicationId",
      department_id AS "departmentId", interviewer_person_id AS "interviewerPersonId",
      interview_schema_id AS "interviewSchemaId", assigned_by_person_id AS "assignedByPersonId",
      to_char(assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "assignedAt",
      revision
    FROM recruitment_interviews WHERE interview_id = ${interviewId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(
            Schema.Struct({
              interviewId: Schema.String,
              applicationId: Schema.String,
              departmentId: Schema.String,
              interviewerPersonId: Schema.String,
              interviewSchemaId: Schema.String,
              assignedByPersonId: Schema.String,
              assignedAt: Schema.String,
              revision: Schema.Number,
            }),
            rows[0],
            "interview row",
          ),
    ),
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("read interview", cause))),
  );

const readSchedule = (sql: DatabaseShape, interviewId: string, lock: boolean) =>
  sql<ScheduleRow>`
    SELECT interview_id AS "interviewId",
      to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "scheduledAt",
      room, campus, map_link AS "mapLink", message, scheduled_by_person_id AS "scheduledByPersonId",
      to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "committedAt",
      schedule_revision AS "scheduleRevision"
    FROM recruitment_interview_schedules WHERE interview_id = ${interviewId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(
            Schema.Struct({
              interviewId: Schema.String,
              scheduledAt: Schema.String,
              room: Schema.String,
              campus: Schema.NullOr(Schema.String),
              mapLink: Schema.NullOr(Schema.String),
              message: Schema.String,
              scheduledByPersonId: Schema.String,
              committedAt: Schema.String,
              scheduleRevision: Schema.Number,
            }),
            rows[0],
            "schedule row",
          ),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read interview schedule", cause)),
    ),
  );

const readInvitation = (sql: DatabaseShape, interviewId: string, lock: boolean) =>
  sql<InvitationRow>`
    SELECT response_state AS "responseState" FROM recruitment_invitations
    WHERE interview_id = ${interviewId} AND superseded_at IS NULL
    ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(Schema.Struct({ responseState: Schema.String }), rows[0], "invitation row"),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read interview invitation", cause)),
    ),
  );

const readQuestions = (sql: DatabaseShape, interviewId: string, lock: boolean) =>
  sql<Record<string, unknown>>`
    SELECT interview_id AS "interviewId", question_id AS "questionId", ordinal, prompt,
      help_text AS "helpText", kind, alternatives
    FROM public.recruitment_interview_question_snapshots WHERE interview_id = ${interviewId}
    ORDER BY ordinal ASC ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decode(RecruitmentInterviewQuestionSnapshot, row, "question snapshot"),
      ),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read question snapshots", cause)),
    ),
  );

const readConduct = (sql: DatabaseShape, interviewId: string, lock: boolean) =>
  sql<ConductRow>`
    SELECT answers, explanatory_power AS "explanatoryPower", role_model AS "roleModel",
      suitability, finalized_by_person_id AS "finalizedByPersonId",
      to_char(finalized_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "finalizedAt",
      interview_revision AS "interviewRevision"
    FROM public.recruitment_interview_conducts WHERE interview_id = ${interviewId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(
            Schema.Struct({
              answers: Schema.Unknown,
              explanatoryPower: Schema.Number,
              roleModel: Schema.Number,
              suitability: Schema.Number,
              finalizedByPersonId: Schema.String,
              finalizedAt: Schema.String,
              interviewRevision: Schema.Number,
            }),
            rows[0],
            "conduct row",
          ),
    ),
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("read conduct", cause))),
  );

const readCancellation = (sql: DatabaseShape, interviewId: string, lock: boolean) =>
  sql<CancellationRow>`
    SELECT cancelled_by_person_id AS "cancelledByPersonId",
      to_char(cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "cancelledAt",
      interview_revision AS "interviewRevision"
    FROM public.recruitment_interview_cancellations WHERE interview_id = ${interviewId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(
            Schema.Struct({
              cancelledByPersonId: Schema.String,
              cancelledAt: Schema.String,
              interviewRevision: Schema.Number,
            }),
            rows[0],
            "cancellation row",
          ),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read cancellation", cause)),
    ),
  );

const readReceipt = (sql: DatabaseShape, commandId: string, lock: boolean) =>
  sql<ReceiptRow>`
    SELECT command_sha256 AS "commandSha256", interview_id AS "interviewId", kind,
      resulting_revision AS "resultingRevision", observation_json AS "observationJson"
    FROM public.recruitment_interview_lifecycle_command_receipts WHERE command_id = ${commandId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(
            Schema.Struct({
              commandSha256: Schema.String,
              interviewId: Schema.String,
              kind: Schema.String,
              resultingRevision: Schema.Number,
              observationJson: Schema.Unknown,
            }),
            rows[0],
            "lifecycle receipt",
          ),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read lifecycle receipt", cause)),
    ),
  );

const stateFor = (
  interview: InterviewRow,
  schedule: ScheduleRow | undefined,
  invitation: InvitationRow | undefined,
  questions: ReadonlyArray<RecruitmentInterviewQuestionSnapshotValue>,
  conduct: ConductRow | undefined,
  cancellation: CancellationRow | undefined,
): Effect.Effect<RecruitmentConductState, RecruitmentFailure> =>
  Effect.gen(function* () {
    const interviewValue = yield* decode(RecruitmentInterview, interview, "interview");
    const scheduleValue =
      schedule === undefined
        ? null
        : yield* decode(RecruitmentInterviewSchedule, schedule, "schedule");
    const conductValue =
      conduct === undefined
        ? null
        : yield* decode(
            RecruitmentInterviewConduct,
            {
              interviewId: interview.interviewId,
              answers: conduct.answers,
              score: {
                explanatoryPower: conduct.explanatoryPower,
                roleModel: conduct.roleModel,
                suitability: conduct.suitability,
              },
              finalizedByPersonId: conduct.finalizedByPersonId,
              finalizedAt: conduct.finalizedAt,
              interviewRevision: conduct.interviewRevision,
            },
            "conduct",
          );
    const cancellationValue =
      cancellation === undefined
        ? null
        : yield* decode(
            RecruitmentInterviewCancellation,
            {
              interviewId: interview.interviewId,
              cancelledByPersonId: cancellation.cancelledByPersonId,
              cancelledAt: cancellation.cancelledAt,
              interviewRevision: cancellation.interviewRevision,
            },
            "cancellation",
          );
    return {
      interview: interviewValue,
      schedule: scheduleValue,
      invitationResponse:
        invitation === undefined
          ? null
          : yield* decode(
              RecruitmentInvitationResponseStateSchema,
              invitation.responseState,
              "invitation response",
            ),
      questions,
      conduct: conductValue,
      cancellation: cancellationValue,
      revision: interview.revision,
    };
  });

const authorityActor = (
  organization: OrganizationShape,
  personId: PersonId,
  departmentId: typeof RecruitmentInterview.fields.departmentId.Type,
  authorizationInstant: string,
): Effect.Effect<typeof RecruitmentConductActorSchema.Type, RecruitmentFailure> =>
  Effect.gen(function* () {
    const authority = yield* organization.resolvePersonAuthority(personId, authorizationInstant);
    const membership = authority.memberships.find(
      (entry) => entry.departmentId === departmentId && entry.active,
    );
    if (membership === undefined) {
      return yield* new RecruitmentScopeDenied({ personId, departmentId });
    }
    return yield* decode(
      RecruitmentConductActorSchema,
      {
        personId,
        departmentId,
        active: true,
        membershipActive: membership.active,
        teamActive: membership.active,
        departmentActive: membership.active,
      },
      "conduct actor",
    );
  });

const authorizeAndLoad = (
  sql: DatabaseShape,
  organization: OrganizationShape,
  context: RecruitmentConductContext,
  interviewId: string,
  lock: boolean,
) =>
  Effect.gen(function* () {
    const actorInput = yield* decode(RecruitmentActorSchema, context.actor, "recruitment actor");
    const interview = yield* readInterview(sql, interviewId, lock);
    if (interview === undefined)
      return yield* new RecruitmentInterviewNotFound({ interviewId: interviewId as never });
    const authorizationInstant = context.authorizationInstant ?? context.now;
    const actor = yield* authorityActor(
      organization,
      actorInput.personId,
      interview.departmentId as never,
      authorizationInstant,
    );
    if (interview.interviewerPersonId !== actor.personId) {
      return yield* new RecruitmentScopeDenied({
        personId: actor.personId,
        departmentId: actor.departmentId,
      });
    }
    const schedule = yield* readSchedule(sql, interviewId, lock);
    const invitation = yield* readInvitation(sql, interviewId, lock);
    const questions = yield* readQuestions(sql, interviewId, lock);
    const conduct = yield* readConduct(sql, interviewId, lock);
    const cancellation = yield* readCancellation(sql, interviewId, lock);
    return { actor, interview, schedule, invitation, questions, conduct, cancellation };
  });
const observation = (
  state: RecruitmentConductState,
  applicant: {
    readonly applicantId: string;
    readonly firstName: string;
    readonly lastName: string;
  },
): Effect.Effect<RecruitmentInterviewConductObservation, RecruitmentFailure> =>
  Effect.gen(function* () {
    if (state.schedule === null)
      return yield* new RecruitmentInterviewNotScheduled({
        interviewId: state.interview.interviewId,
      });
    if (state.invitationResponse !== "Accepted") {
      return yield* new RecruitmentInvitationNotAccepted({
        interviewId: state.interview.interviewId,
        responseState: state.invitationResponse ?? "Absent",
      });
    }
    return yield* decode(
      RecruitmentInterviewConductObservationSchema,
      {
        interviewId: state.interview.interviewId,
        applicationId: state.interview.applicationId,
        applicant,
        schedule: state.schedule,
        invitationResponse: "Accepted",
        questions: state.questions,
        answers: state.conduct?.answers ?? [],
        score: state.conduct?.score ?? null,
        completionState: state.conduct === null ? "NotCompleted" : "Completed",
        cancellationState: state.cancellation === null ? "NotCancelled" : "Cancelled",
        finalizedAt: state.conduct?.finalizedAt ?? null,
        cancelledAt: state.cancellation?.cancelledAt ?? null,
        revision: state.revision,
        canFinalize: state.conduct === null && state.cancellation === null,
        canCancel: state.conduct === null && state.cancellation === null,
      },
      "conduct observation",
    );
  });

const readApplicant = (admissions: AdmissionsShape, applicationId: string) =>
  admissions.readApplicantContacts([applicationId as never]).pipe(
    Effect.map((rows) => rows[0]),
    Effect.flatMap((row) =>
      row === undefined
        ? Effect.fail(persistenceError("resolve conduct applicant"))
        : Effect.succeed({
            applicantId: row.applicantId,
            firstName: row.firstName,
            lastName: row.lastName,
          }),
    ),
    Effect.mapError((cause) => persistenceError("resolve conduct applicant", cause)),
  );

export const readInterviewConduct = (
  interviewId: RecruitmentInterviewId,
  context: RecruitmentConductContext,
): Effect.Effect<
  RecruitmentInterviewConductObservation,
  RecruitmentFailure,
  Database | Admissions | Organization
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const admissions = yield* Admissions;
    const organization = yield* Organization;
    const loaded = yield* authorizeAndLoad(sql, organization, context, interviewId, false);
    const state = yield* stateFor(
      loaded.interview,
      loaded.schedule,
      loaded.invitation,
      loaded.questions,
      loaded.conduct,
      loaded.cancellation,
    );
    const applicant = yield* readApplicant(admissions, loaded.interview.applicationId);
    return yield* observation(state, applicant);
  });
const finalizeInTransaction = (
  command: FinalizeInterviewCommand,
  context: RecruitmentConductContext,
  sql: DatabaseShape,
  organization: OrganizationShape,
  digest: string,
): Effect.Effect<FinalizeInterviewResult, RecruitmentFailure> =>
  Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`;
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.interviewId}, 0))`;
    const loaded = yield* authorizeAndLoad(sql, organization, context, command.interviewId, true);
    const receipt = yield* readReceipt(sql, command.commandId, true);
    if (receipt !== undefined) {
      if (
        receipt.commandSha256 !== digest ||
        receipt.interviewId !== command.interviewId ||
        receipt.kind !== "InterviewFinalized"
      ) {
        return yield* new RecruitmentLifecycleCommandConflict({ commandId: command.commandId });
      }
      const stored = yield* decode(
        FinalizeInterviewObservationSchema,
        receipt.observationJson,
        "finalization receipt observation",
      );
      return yield* decode(
        FinalizeInterviewResultSchema,
        { observation: stored, replayed: true },
        "finalization replay result",
      );
    }
    const state = yield* stateFor(
      loaded.interview,
      loaded.schedule,
      loaded.invitation,
      loaded.questions,
      loaded.conduct,
      loaded.cancellation,
    );
    const transition = yield* applyFinalization(state, command, loaded.actor, context.now);
    const conduct = transition.state.conduct;
    if (conduct === null)
      return yield* new RecruitmentConductValidationError({
        interviewId: command.interviewId,
        message: "finalization produced no conduct",
      });
    const updated = yield* sql<{
      readonly revision: number;
    }>`UPDATE recruitment_interviews SET revision = revision + 1 WHERE interview_id = ${command.interviewId} AND revision = ${command.expectedRevision} RETURNING revision`;
    if (updated[0]?.revision !== transition.state.revision)
      return yield* new RecruitmentInterviewStaleRevision({
        interviewId: command.interviewId,
        expectedRevision: command.expectedRevision,
        actualRevision: loaded.interview.revision,
      });
    yield* sql`INSERT INTO public.recruitment_interview_conducts (interview_id, answers, explanatory_power, role_model, suitability, finalized_by_person_id, finalized_at, interview_revision) VALUES (${conduct.interviewId}, ${canonicalJson(conduct.answers)}::jsonb, ${conduct.score.explanatoryPower}, ${conduct.score.roleModel}, ${conduct.score.suitability}, ${conduct.finalizedByPersonId}, ${conduct.finalizedAt}, ${conduct.interviewRevision})`;
    yield* sql`INSERT INTO public.recruitment_interview_lifecycle_command_receipts (command_id, command_sha256, command_json, observation_json, kind, interview_id, resulting_revision, committed_at) VALUES (${command.commandId}, ${digest}, ${canonicalJson(command)}::jsonb, ${canonicalJson(transition.observation)}::jsonb, 'InterviewFinalized', ${command.interviewId}, ${transition.observation.interviewRevision}, ${context.now})`;
    yield* sql`INSERT INTO public.recruitment_interview_lifecycle_audit (command_id, interview_id, kind, actor_person_id, resulting_revision, occurred_at) VALUES (${command.commandId}, ${command.interviewId}, 'InterviewFinalized', ${loaded.actor.personId}, ${transition.observation.interviewRevision}, ${context.now})`;
    return yield* decode(
      FinalizeInterviewResultSchema,
      { observation: transition.observation, replayed: false },
      "finalization result",
    );
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("finalization transaction", cause)),
    ),
  );

const cancelInTransaction = (
  command: CancelInterviewCommand,
  context: RecruitmentConductContext,
  sql: DatabaseShape,
  organization: OrganizationShape,
  digest: string,
): Effect.Effect<CancelInterviewResult, RecruitmentFailure> =>
  Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`;
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.interviewId}, 0))`;
    const loaded = yield* authorizeAndLoad(sql, organization, context, command.interviewId, true);
    const receipt = yield* readReceipt(sql, command.commandId, true);
    if (receipt !== undefined) {
      if (
        receipt.commandSha256 !== digest ||
        receipt.interviewId !== command.interviewId ||
        receipt.kind !== "InterviewCancelled"
      ) {
        return yield* new RecruitmentLifecycleCommandConflict({ commandId: command.commandId });
      }
      const stored = yield* decode(
        CancelInterviewObservationSchema,
        receipt.observationJson,
        "cancellation receipt observation",
      );
      return yield* decode(
        CancelInterviewResultSchema,
        { observation: stored, replayed: true },
        "cancellation replay result",
      );
    }
    const state = yield* stateFor(
      loaded.interview,
      loaded.schedule,
      loaded.invitation,
      loaded.questions,
      loaded.conduct,
      loaded.cancellation,
    );
    const transition = yield* applyCancellation(state, command, loaded.actor, context.now);
    const cancellation = transition.state.cancellation;
    if (cancellation === null)
      return yield* new RecruitmentConductValidationError({
        interviewId: command.interviewId,
        message: "cancellation produced no record",
      });
    const updated = yield* sql<{
      readonly revision: number;
    }>`UPDATE recruitment_interviews SET revision = revision + 1 WHERE interview_id = ${command.interviewId} AND revision = ${command.expectedRevision} RETURNING revision`;
    if (updated[0]?.revision !== transition.state.revision)
      return yield* new RecruitmentInterviewStaleRevision({
        interviewId: command.interviewId,
        expectedRevision: command.expectedRevision,
        actualRevision: loaded.interview.revision,
      });
    yield* sql`INSERT INTO public.recruitment_interview_cancellations (interview_id, cancelled_by_person_id, cancelled_at, interview_revision) VALUES (${cancellation.interviewId}, ${cancellation.cancelledByPersonId}, ${cancellation.cancelledAt}, ${cancellation.interviewRevision})`;
    yield* sql`INSERT INTO public.recruitment_interview_lifecycle_command_receipts (command_id, command_sha256, command_json, observation_json, kind, interview_id, resulting_revision, committed_at) VALUES (${command.commandId}, ${digest}, ${canonicalJson(command)}::jsonb, ${canonicalJson(transition.observation)}::jsonb, 'InterviewCancelled', ${command.interviewId}, ${transition.observation.interviewRevision}, ${context.now})`;
    yield* sql`INSERT INTO public.recruitment_interview_lifecycle_audit (command_id, interview_id, kind, actor_person_id, resulting_revision, occurred_at) VALUES (${command.commandId}, ${command.interviewId}, 'InterviewCancelled', ${loaded.actor.personId}, ${transition.observation.interviewRevision}, ${context.now})`;
    return yield* decode(
      CancelInterviewResultSchema,
      { observation: transition.observation, replayed: false },
      "cancellation result",
    );
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("cancellation transaction", cause)),
    ),
  );

export const finalizeInterview = (
  command: FinalizeInterviewCommand,
  context: RecruitmentConductContext,
): Effect.Effect<FinalizeInterviewResult, RecruitmentFailure, Database | Organization> =>
  Effect.gen(function* () {
    const decoded = yield* decode(FinalizeInterviewCommandSchema, command, "finalization command");
    const sql = yield* Database;
    const organization = yield* Organization;
    return yield* sql
      .withTransaction(
        finalizeInTransaction(
          decoded,
          context,
          sql,
          organization,
          sha256Hex(canonicalJsonBytes(decoded)),
        ),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("finalization transaction", cause)),
        ),
      );
  });

export const cancelInterview = (
  command: CancelInterviewCommand,
  context: RecruitmentConductContext,
): Effect.Effect<CancelInterviewResult, RecruitmentFailure, Database | Organization> =>
  Effect.gen(function* () {
    const decoded = yield* decode(CancelInterviewCommandSchema, command, "cancellation command");
    const sql = yield* Database;
    const organization = yield* Organization;
    return yield* sql
      .withTransaction(
        cancelInTransaction(
          decoded,
          context,
          sql,
          organization,
          sha256Hex(canonicalJsonBytes(decoded)),
        ),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("cancellation transaction", cause)),
        ),
      );
  });
