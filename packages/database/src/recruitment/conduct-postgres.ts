import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { guardInterviewApplicantIdentity } from "./conduct-identity.js";
import { Admissions, type AdmissionsOperations } from "@vektorprogrammet/domain/admissions";
import { Database, type DatabaseOperations } from "../service.js";
import {
  DepartmentId,
  Organization,
  type OrganizationOperations,
} from "@vektorprogrammet/domain/organization";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { flow, Effect, Schema } from "effect";
import {
  CorrectionHistoryOriginalSchema,
  RecruitmentConductValidationError,
  RecruitmentInterviewNotFound,
  RecruitmentInterviewNotScheduled,
  RecruitmentInvitationNotAccepted,
  RecruitmentLifecycleCommandConflict,
  RecruitmentPersistenceError,
  RecruitmentScopeDenied,
  RecruitmentInterviewStaleRevision,
} from "@vektorprogrammet/domain/recruitment";
import {
  cancelInterview as applyCancellation,
  correctInterviewAssessment as applyCorrection,
  finalizeInterview as applyFinalization,
} from "@vektorprogrammet/domain/recruitment";
import {
  CancelInterviewCommandSchema,
  CancelInterviewObservationSchema,
  CancelInterviewResultSchema,
  CorrectInterviewAssessmentCommandSchema,
  CorrectInterviewAssessmentObservationSchema,
  CorrectInterviewAssessmentResultSchema,
  FinalizeInterviewCommandSchema,
  FinalizeInterviewObservationSchema,
  FinalizeInterviewResultSchema,
  RecruitmentConductActorSchema,
  RecruitmentInterviewCancellation,
  InterviewRecommendationSchema,
  RecruitmentInterviewConduct,
  RecruitmentInterviewQuestionSnapshot,
  RecruitmentInterviewConductObservationSchema,
  RecruitmentInterview,
  RecruitmentInterviewSchedule,
  RecruitmentInvitationResponseStateSchema,
  RecruitmentActorSchema,
  RecruitmentInterviewCorrectionHistoryEntrySchema,
  type CancelInterviewCommand,
  type CancelInterviewResult,
  RecruitmentInterviewId,
  type CorrectInterviewAssessmentCommand,
  type CorrectInterviewAssessmentResult,
  type FinalizeInterviewCommand,
  type FinalizeInterviewResult,
  type RecruitmentConductContext,
  type RecruitmentConductState,
  type RecruitmentInterviewConductObservation,
  type RecruitmentInterviewQuestionSnapshotValue,
} from "@vektorprogrammet/domain/recruitment";
import type { RecruitmentFailure } from "@vektorprogrammet/domain/recruitment";

interface InterviewRow {
  readonly interviewId: string;
  readonly applicationId: string;
  readonly departmentId: string;
  readonly interviewerPersonId: string;
  readonly coInterviewerPersonId: string | null;
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

interface CorrectionRow {
  readonly interviewId: string;
  readonly predecessorRevision: number;
  readonly resultingRevision: number;
  readonly answers: unknown;
  readonly explanatoryPower: number;
  readonly roleModel: number;
  readonly suitability: number;
  readonly recommendation: "Ja" | "Kanskje" | "Nei";
  readonly correctedByPersonId: string;
  readonly correctedAt: string;
  readonly commandId: string;
}

interface ReceiptRow {
  readonly commandSha256: string;
  readonly interviewId: string;
  readonly kind: string;
  readonly resultingRevision: number;
  readonly observationJson: unknown;
}

interface CorrectionReceiptRow {
  readonly commandSha256: string;
  readonly interviewId: string;
  readonly predecessorRevision: number;
  readonly resultingRevision: number;
  readonly observationJson: unknown;
}

interface ConductRow {
  readonly answers: unknown;
  readonly explanatoryPower: number;
  readonly roleModel: number;
  readonly suitability: number;
  readonly recommendation: "Ja" | "Kanskje" | "Nei" | null;
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
    cause,
    message:
      cause instanceof Error ? cause.message : String(cause ?? "recruitment persistence failed"),
  });

const decode = <A>(schema: Schema.ConstraintDecoder<A, never>, operation: string) =>
  flow(
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" }),
    Effect.mapError(
      (cause) =>
        new RecruitmentPersistenceError({
          operation: `decode ${operation}`,
          message: String(cause),
        }),
    ),
  );

const readInterview = (sql: DatabaseOperations, interviewId: string, lock: boolean) =>
  sql<InterviewRow>`
    SELECT interview_id AS "interviewId", application_id AS "applicationId",
      department_id AS "departmentId", interviewer_person_id AS "interviewerPersonId",
      co_interviewer_person_id AS "coInterviewerPersonId",
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
              coInterviewerPersonId: Schema.NullOr(Schema.String),
              interviewSchemaId: Schema.String,
              assignedByPersonId: Schema.String,
              assignedAt: Schema.String,
              revision: Schema.Number,
            }),
            "interview row",
          )(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("read interview", cause))),
  );

const readSchedule = (sql: DatabaseOperations, interviewId: string, lock: boolean) =>
  sql<ScheduleRow>`
    SELECT interview_id AS "interviewId",
      to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "scheduledAt",
      room, campus, map_link AS "mapLink", message, scheduled_by_person_id AS "scheduledByPersonId",
      to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "committedAt",
      schedule_revision AS "scheduleRevision"
    FROM recruitment_interview_schedules AS schedule WHERE interview_id = ${interviewId}
      AND EXISTS (
        SELECT 1 FROM recruitment_invitations AS invitation
        WHERE invitation.interview_id = schedule.interview_id
          AND invitation.schedule_revision = schedule.schedule_revision AND invitation.superseded_at IS NULL
      )
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
            "schedule row",
          )(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read interview schedule", cause)),
    ),
  );

const readInvitation = (sql: DatabaseOperations, interviewId: string, lock: boolean) =>
  sql<InvitationRow>`
    SELECT response_state AS "responseState" FROM recruitment_invitations
    WHERE interview_id = ${interviewId} AND superseded_at IS NULL
    ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(Schema.Struct({ responseState: Schema.String }), "invitation row")(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read interview invitation", cause)),
    ),
  );

const readQuestions = (sql: DatabaseOperations, interviewId: string, lock: boolean) =>
  sql`
    SELECT interview_id AS "interviewId", question_id AS "questionId", ordinal, prompt,
      help_text AS "helpText", kind, alternatives
    FROM public.recruitment_interview_question_snapshots WHERE interview_id = ${interviewId}
    ORDER BY ordinal ASC ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decode(RecruitmentInterviewQuestionSnapshot, "question snapshot")(row),
      ),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read question snapshots", cause)),
    ),
  );

const readConduct = (sql: DatabaseOperations, interviewId: string, lock: boolean) =>
  sql<ConductRow>`
    SELECT answers, explanatory_power AS "explanatoryPower", role_model AS "roleModel",
      suitability, recommendation, finalized_by_person_id AS "finalizedByPersonId",
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
              recommendation: Schema.NullOr(InterviewRecommendationSchema),
              finalizedByPersonId: Schema.String,
              finalizedAt: Schema.String,
              interviewRevision: Schema.Number,
            }),
            "conduct row",
          )(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("read conduct", cause))),
  );

const readCorrections = (sql: DatabaseOperations, interviewId: string, lock: boolean) =>
  sql<CorrectionRow>`
    SELECT interview_id AS "interviewId", predecessor_revision AS "predecessorRevision",
      resulting_revision AS "resultingRevision", answers,
      explanatory_power AS "explanatoryPower", role_model AS "roleModel",
      suitability, recommendation, corrected_by_person_id AS "correctedByPersonId",
      to_char(corrected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "correctedAt",
      command_id AS "commandId"
    FROM public.recruitment_interview_correction_assessments
    WHERE interview_id = ${interviewId}
    ORDER BY resulting_revision ASC ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decode(
          Schema.Struct({
            interviewId: Schema.String,
            predecessorRevision: Schema.Number,
            resultingRevision: Schema.Number,
            answers: Schema.Unknown,
            explanatoryPower: Schema.Number,
            roleModel: Schema.Number,
            suitability: Schema.Number,
            recommendation: InterviewRecommendationSchema,
            correctedByPersonId: Schema.String,
            correctedAt: Schema.String,
            commandId: Schema.String,
          }),
          "correction row",
        )(row),
      ),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read interview corrections", cause)),
    ),
  );

const readCancellation = (sql: DatabaseOperations, interviewId: string, lock: boolean) =>
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
            "cancellation row",
          )(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read cancellation", cause)),
    ),
  );

const readReceipt = (sql: DatabaseOperations, commandId: string, lock: boolean) =>
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
            "lifecycle receipt",
          )(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read lifecycle receipt", cause)),
    ),
  );

const readCorrectionReceipt = (sql: DatabaseOperations, commandId: string, lock: boolean) =>
  sql<CorrectionReceiptRow>`
    SELECT command_sha256 AS "commandSha256", interview_id AS "interviewId",
      predecessor_revision AS "predecessorRevision", resulting_revision AS "resultingRevision",
      observation_json AS "observationJson"
    FROM public.recruitment_interview_correction_command_receipts
    WHERE command_id = ${commandId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(
            Schema.Struct({
              commandSha256: Schema.String,
              interviewId: Schema.String,
              predecessorRevision: Schema.Number,
              resultingRevision: Schema.Number,
              observationJson: Schema.Unknown,
            }),
            "correction receipt",
          )(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read correction receipt", cause)),
    ),
  );

interface EffectiveAssessmentRow {
  readonly answers: unknown;
  readonly explanatoryPower: number;
  readonly roleModel: number;
  readonly suitability: number;
  readonly recommendation: "Ja" | "Kanskje" | "Nei" | null;
  readonly effectiveRevision: number;
}

const readEffectiveAssessment = (sql: DatabaseOperations, interviewId: string) =>
  sql<EffectiveAssessmentRow>`
     SELECT answers, explanatory_power AS "explanatoryPower", role_model AS "roleModel",
       suitability, recommendation, effective_revision AS "effectiveRevision"
     FROM public.recruitment_interview_effective_assessments
     WHERE interview_id = ${interviewId}
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
              recommendation: Schema.NullOr(InterviewRecommendationSchema),
              effectiveRevision: Schema.Number,
            }),
            "effective assessment",
          )(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read effective assessment", cause)),
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
    const interviewValue = yield* decode(RecruitmentInterview, "interview")(interview);

    const scheduleValue =
      schedule === undefined
        ? null
        : yield* decode(RecruitmentInterviewSchedule, "schedule")(schedule);

    const conductValue =
      conduct === undefined
        ? null
        : yield* decode(
            RecruitmentInterviewConduct,
            "conduct",
          )({
            interviewId: interview.interviewId,
            answers: conduct.answers,
            recommendation: conduct.recommendation,
            score: {
              explanatoryPower: conduct.explanatoryPower,
              roleModel: conduct.roleModel,
              suitability: conduct.suitability,
            },
            finalizedByPersonId: conduct.finalizedByPersonId,
            finalizedAt: conduct.finalizedAt,
            interviewRevision: conduct.interviewRevision,
          });

    const cancellationValue =
      cancellation === undefined
        ? null
        : yield* decode(
            RecruitmentInterviewCancellation,
            "cancellation",
          )({
            interviewId: interview.interviewId,
            cancelledByPersonId: cancellation.cancelledByPersonId,
            cancelledAt: cancellation.cancelledAt,
            interviewRevision: cancellation.interviewRevision,
          });

    return {
      interview: interviewValue,
      schedule: scheduleValue,
      invitationResponse:
        invitation === undefined
          ? null
          : yield* decode(
              RecruitmentInvitationResponseStateSchema,
              "invitation response",
            )(invitation.responseState),
      questions,
      conduct: conductValue,
      cancellation: cancellationValue,
      revision: interview.revision,
    };
  });

const authorityActor = (
  organization: OrganizationOperations,
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
      "conduct actor",
    )({
      personId,
      departmentId,
      active: true,
      membershipActive: membership.active,
      teamActive: membership.active,
      departmentActive: membership.active,
    });
  });

type InterviewAccessMode = "PrimaryInterviewer" | "InterviewParticipant";

const authorizeAndLoad = (
  sql: DatabaseOperations,
  organization: OrganizationOperations,
  context: RecruitmentConductContext,
  interviewId: string,
  lock: boolean,
  accessMode: InterviewAccessMode,
) =>
  Effect.gen(function* () {
    const actorInput = yield* decode(RecruitmentActorSchema, "recruitment actor")(context.actor);
    yield* guardInterviewApplicantIdentity(
      RecruitmentInterviewId.make(interviewId),
      actorInput.personId,
    ).pipe(Effect.provideService(Database, sql));
    // Keep schedule and invitation observations on the same generation across these reads.
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${interviewId}, 0))`;
    const interview = yield* readInterview(sql, interviewId, lock);

    if (interview === undefined)
      return yield* new RecruitmentInterviewNotFound({
        interviewId: RecruitmentInterviewId.make(interviewId),
      });
    const authorizationInstant = context.authorizationInstant ?? context.now;

    const actor = yield* authorityActor(
      organization,
      actorInput.personId,
      DepartmentId.make(interview.departmentId),
      authorizationInstant,
    );

    const isCoInterviewer =
      accessMode === "InterviewParticipant" && interview.coInterviewerPersonId === actor.personId;

    const isParticipant = interview.interviewerPersonId === actor.personId || isCoInterviewer;

    if (!isParticipant) {
      return yield* new RecruitmentScopeDenied({
        personId: actor.personId,
        departmentId: actor.departmentId,
      });
    }

    const coInterviewerConduct = isCoInterviewer
      ? yield* readConduct(sql, interviewId, lock)
      : undefined;

    if (isCoInterviewer && coInterviewerConduct === undefined) {
      return yield* new RecruitmentScopeDenied({
        personId: actor.personId,
        departmentId: actor.departmentId,
      });
    }

    const schedule = yield* readSchedule(sql, interviewId, lock);
    const invitation = yield* readInvitation(sql, interviewId, lock);
    const questions = yield* readQuestions(sql, interviewId, lock);
    const conduct = coInterviewerConduct ?? (yield* readConduct(sql, interviewId, lock));
    const corrections = yield* readCorrections(sql, interviewId, lock);
    const effective = yield* readEffectiveAssessment(sql, interviewId);
    const cancellation = yield* readCancellation(sql, interviewId, lock);

    return {
      actor,
      interview,
      schedule,
      invitation,
      questions,
      conduct,
      corrections,
      effective,
      cancellation,
    };
  });

const observation = (
  state: RecruitmentConductState,
  applicant: {
    readonly applicantId: string;
    readonly firstName: string;
    readonly lastName: string;
  },
  corrections: ReadonlyArray<CorrectionRow>,
  effective: EffectiveAssessmentRow | undefined,
  actor: typeof RecruitmentConductActorSchema.Type,
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

    const history =
      state.conduct === null
        ? []
        : yield* decode(
            Schema.Array(RecruitmentInterviewCorrectionHistoryEntrySchema),
            "correction history",
          )([
            CorrectionHistoryOriginalSchema.make({
              revision: state.conduct.interviewRevision,
              answers: state.conduct.answers,
              score: state.conduct.score,
              recommendation: state.conduct.recommendation,
              finalizedByPersonId: state.conduct.finalizedByPersonId,
              finalizedAt: state.conduct.finalizedAt,
            }),
            ...corrections.map((correction) => ({
              _tag: "Correction" as const,
              revision: correction.resultingRevision,
              predecessorRevision: correction.predecessorRevision,
              answers: correction.answers,
              score: {
                explanatoryPower: correction.explanatoryPower,
                roleModel: correction.roleModel,
                suitability: correction.suitability,
              },
              recommendation: correction.recommendation,
              correctedByPersonId: correction.correctedByPersonId,
              correctedAt: correction.correctedAt,
              commandId: correction.commandId,
            })),
          ]);

    const canManageLifecycle =
      state.interview.interviewerPersonId === actor.personId &&
      state.conduct === null &&
      state.cancellation === null;

    return yield* decode(
      RecruitmentInterviewConductObservationSchema,
      "conduct observation",
    )({
      interviewId: state.interview.interviewId,
      applicationId: state.interview.applicationId,
      applicant,
      schedule: state.schedule,
      invitationResponse: "Accepted",
      questions: state.questions,
      answers: effective?.answers ?? state.conduct?.answers ?? [],
      score:
        effective === undefined
          ? (state.conduct?.score ?? null)
          : {
              explanatoryPower: effective.explanatoryPower,
              roleModel: effective.roleModel,
              suitability: effective.suitability,
            },
      recommendation: effective?.recommendation ?? state.conduct?.recommendation ?? null,
      completionState: state.conduct === null ? "NotCompleted" : "Completed",
      cancellationState: state.cancellation === null ? "NotCancelled" : "Cancelled",
      finalizedByPersonId: state.conduct?.finalizedByPersonId ?? null,
      finalizedAt: state.conduct?.finalizedAt ?? null,
      effectiveRevision: effective?.effectiveRevision ?? state.revision,
      history,
      cancelledAt: state.cancellation?.cancelledAt ?? null,
      revision: state.revision,
      canFinalize: canManageLifecycle,
      canCancel: canManageLifecycle,
    });
  });

const readApplicant = (admissions: AdmissionsOperations, applicationId: string) =>
  admissions.readApplicantContacts([PublicApplicationIdSchema.make(applicationId)]).pipe(
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

    return yield* sql
      .withTransaction(readInterviewConductInTransaction(interviewId, context, sql))
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("conduct observation", cause)),
        ),
      );
  });

export const readInterviewConductInTransaction = (
  interviewId: RecruitmentInterviewId,
  context: RecruitmentConductContext,
  sql: DatabaseOperations,
): Effect.Effect<
  RecruitmentInterviewConductObservation,
  RecruitmentFailure,
  Admissions | Organization
> =>
  Effect.gen(function* () {
    const admissions = yield* Admissions;
    const organization = yield* Organization;

    const loaded = yield* authorizeAndLoad(
      sql,
      organization,
      context,
      interviewId,
      false,
      "InterviewParticipant",
    );

    const state = yield* stateFor(
      loaded.interview,
      loaded.schedule,
      loaded.invitation,
      loaded.questions,
      loaded.conduct,
      loaded.cancellation,
    );

    const applicant = yield* readApplicant(admissions, loaded.interview.applicationId);

    return yield* observation(state, applicant, loaded.corrections, loaded.effective, loaded.actor);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("conduct observation", cause)),
    ),
  );

const finalizeInTransaction = (
  command: FinalizeInterviewCommand,
  context: RecruitmentConductContext,
  sql: DatabaseOperations,
  organization: OrganizationOperations,
  digest: string,
): Effect.Effect<FinalizeInterviewResult, RecruitmentFailure> =>
  Effect.gen(function* () {
    yield* guardInterviewApplicantIdentity(command.interviewId, context.actor.personId).pipe(
      Effect.provideService(Database, sql),
    );
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`;
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.interviewId}, 0))`;

    const loaded = yield* authorizeAndLoad(
      sql,
      organization,
      context,
      command.interviewId,
      true,
      "PrimaryInterviewer",
    );

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
        "finalization receipt observation",
      )(receipt.observationJson);

      return yield* decode(
        FinalizeInterviewResultSchema,
        "finalization replay result",
      )({ observation: stored, replayed: true });
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
    yield* sql`INSERT INTO public.recruitment_interview_conducts (interview_id, answers, explanatory_power, role_model, suitability, recommendation, finalized_by_person_id, finalized_at, interview_revision) VALUES (${conduct.interviewId}, ${canonicalJson(conduct.answers)}::jsonb, ${conduct.score.explanatoryPower}, ${conduct.score.roleModel}, ${conduct.score.suitability}, ${conduct.recommendation}, ${conduct.finalizedByPersonId}, ${conduct.finalizedAt}, ${conduct.interviewRevision})`;
    yield* sql`INSERT INTO public.recruitment_interview_lifecycle_command_receipts (command_id, command_sha256, command_json, observation_json, kind, interview_id, resulting_revision, committed_at) VALUES (${command.commandId}, ${digest}, ${canonicalJson(command)}::jsonb, ${canonicalJson(transition.observation)}::jsonb, 'InterviewFinalized', ${command.interviewId}, ${transition.observation.interviewRevision}, ${context.now})`;
    yield* sql`INSERT INTO public.recruitment_interview_lifecycle_audit (command_id, interview_id, kind, actor_person_id, resulting_revision, occurred_at) VALUES (${command.commandId}, ${command.interviewId}, 'InterviewFinalized', ${loaded.actor.personId}, ${transition.observation.interviewRevision}, ${context.now})`;
    yield* sql`INSERT INTO public.recruitment_interview_completion_outbox (effect_id, effect_type, command_id, interview_id, application_id, interview_revision) VALUES (${`recruitment-completion:${digest}`}, 'SendInterviewCompletionReceipt', ${command.commandId}, ${command.interviewId}, ${loaded.interview.applicationId}, ${transition.observation.interviewRevision})`;

    return yield* decode(
      FinalizeInterviewResultSchema,
      "finalization result",
    )({ observation: transition.observation, replayed: false });
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("finalization transaction", cause)),
    ),
  );

const cancelInTransaction = (
  command: CancelInterviewCommand,
  context: RecruitmentConductContext,
  sql: DatabaseOperations,
  organization: OrganizationOperations,
  digest: string,
): Effect.Effect<CancelInterviewResult, RecruitmentFailure> =>
  Effect.gen(function* () {
    yield* guardInterviewApplicantIdentity(command.interviewId, context.actor.personId).pipe(
      Effect.provideService(Database, sql),
    );
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`;
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.interviewId}, 0))`;

    const loaded = yield* authorizeAndLoad(
      sql,
      organization,
      context,
      command.interviewId,
      true,
      "PrimaryInterviewer",
    );

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
        "cancellation receipt observation",
      )(receipt.observationJson);

      return yield* decode(
        CancelInterviewResultSchema,
        "cancellation replay result",
      )({ observation: stored, replayed: true });
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
      "cancellation result",
    )({ observation: transition.observation, replayed: false });
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("cancellation transaction", cause)),
    ),
  );

const correctInTransaction = (
  command: CorrectInterviewAssessmentCommand,
  context: RecruitmentConductContext,
  sql: DatabaseOperations,
  organization: OrganizationOperations,
  digest: string,
): Effect.Effect<CorrectInterviewAssessmentResult, RecruitmentFailure> =>
  Effect.gen(function* () {
    yield* guardInterviewApplicantIdentity(command.interviewId, context.actor.personId).pipe(
      Effect.provideService(Database, sql),
    );
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`;
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.interviewId}, 0))`;

    const loaded = yield* authorizeAndLoad(
      sql,
      organization,
      context,
      command.interviewId,
      true,
      "InterviewParticipant",
    );

    const receipt = yield* readCorrectionReceipt(sql, command.commandId, true);

    if (receipt !== undefined) {
      if (receipt.commandSha256 !== digest || receipt.interviewId !== command.interviewId)
        return yield* new RecruitmentLifecycleCommandConflict({ commandId: command.commandId });

      const stored = yield* decode(
        CorrectInterviewAssessmentObservationSchema,
        "correction receipt observation",
      )(receipt.observationJson);

      return yield* decode(
        CorrectInterviewAssessmentResultSchema,
        "correction replay result",
      )({ observation: stored, replayed: true });
    }

    const state = yield* stateFor(
      loaded.interview,
      loaded.schedule,
      loaded.invitation,
      loaded.questions,
      loaded.conduct,
      loaded.cancellation,
    );

    const correctionState =
      loaded.interview.coInterviewerPersonId === loaded.actor.personId
        ? {
            ...state,
            interview: {
              ...state.interview,
              interviewerPersonId: loaded.actor.personId,
            },
          }
        : state;

    const transition = yield* applyCorrection(correctionState, command, loaded.actor, context.now);

    const updated = yield* sql<{ readonly revision: number }>`
      UPDATE recruitment_interviews
      SET revision = revision + 1
      WHERE interview_id = ${command.interviewId} AND revision = ${command.expectedRevision}
      RETURNING revision
    `;

    if (updated[0]?.revision !== transition.state.revision)
      return yield* new RecruitmentInterviewStaleRevision({
        interviewId: command.interviewId,
        expectedRevision: command.expectedRevision,
        actualRevision: loaded.interview.revision,
      });
    yield* sql`
      INSERT INTO public.recruitment_interview_correction_assessments
        (interview_id, predecessor_revision, resulting_revision, answers,
         explanatory_power, role_model, suitability, recommendation,
         corrected_by_person_id, corrected_at, command_id)
      VALUES
        (${transition.correction.interviewId}, ${transition.correction.predecessorRevision},
         ${transition.correction.resultingRevision}, ${canonicalJson(transition.correction.answers)}::jsonb,
         ${transition.correction.score.explanatoryPower}, ${transition.correction.score.roleModel},
         ${transition.correction.score.suitability}, ${transition.correction.recommendation},
         ${transition.correction.correctedByPersonId}, ${transition.correction.correctedAt},
         ${transition.correction.commandId})
    `;
    yield* sql`
      INSERT INTO public.recruitment_interview_correction_command_receipts
        (command_id, command_sha256, command_json, observation_json, interview_id,
         predecessor_revision, resulting_revision, committed_at)
      VALUES
        (${command.commandId}, ${digest}, ${canonicalJson(command)}::jsonb,
         ${canonicalJson(transition.observation)}::jsonb, ${command.interviewId},
         ${transition.observation.predecessorRevision}, ${transition.observation.resultingRevision},
         ${context.now})
    `;
    yield* sql`
      INSERT INTO public.recruitment_interview_correction_audit
        (command_id, interview_id, actor_person_id, predecessor_revision, resulting_revision, occurred_at)
      VALUES
        (${command.commandId}, ${command.interviewId}, ${loaded.actor.personId},
         ${transition.observation.predecessorRevision}, ${transition.observation.resultingRevision},
         ${context.now})
    `;

    return yield* decode(
      CorrectInterviewAssessmentResultSchema,
      "correction result",
    )({ observation: transition.observation, replayed: false });
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("correction transaction", cause)),
    ),
  );

export const correctInterviewAssessment = (
  command: CorrectInterviewAssessmentCommand,
  context: RecruitmentConductContext,
): Effect.Effect<CorrectInterviewAssessmentResult, RecruitmentFailure, Database | Organization> =>
  Effect.gen(function* () {
    const decoded = yield* decode(
      CorrectInterviewAssessmentCommandSchema,
      "correction command",
    )(command);

    const sql = yield* Database;
    const organization = yield* Organization;

    return yield* sql
      .withTransaction(
        correctInTransaction(
          decoded,
          context,
          sql,
          organization,
          sha256Hex(canonicalJsonBytes(decoded)),
        ),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("correction transaction", cause)),
        ),
      );
  });

export const finalizeInterview = (
  command: FinalizeInterviewCommand,
  context: RecruitmentConductContext,
): Effect.Effect<FinalizeInterviewResult, RecruitmentFailure, Database | Organization> =>
  Effect.gen(function* () {
    const decoded = yield* decode(FinalizeInterviewCommandSchema, "finalization command")(command);
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
    const decoded = yield* decode(CancelInterviewCommandSchema, "cancellation command")(command);
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
