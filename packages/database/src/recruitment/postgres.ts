import { Admissions, type AdmissionsOperations } from "@vektorprogrammet/domain/admissions";
import type { AdmissionPeriodProjection } from "@vektorprogrammet/domain/admission-period";
import { Database, type DatabaseOperations } from "../service.js";
import { Organization, type OrganizationOperations } from "@vektorprogrammet/domain/organization";
import { DepartmentId, PersonId, type Membership } from "@vektorprogrammet/domain/organization";
import { compareRfc3339Instants } from "@vektorprogrammet/domain/time";
import { Profile, type ProfileOperations } from "@vektorprogrammet/domain/profile";
import {
  canonicalJsonValue,
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "@vektorprogrammet/domain/evidence";
import { flow, Predicate, Effect, Schema } from "effect";
import {
  RecruitmentAssignmentObservationSchema,
  RecruitmentAdmissionPeriodNotFound,
  RecruitmentAmbiguousAdmissionPeriod,
  RecruitmentApplicationAlreadyAssigned,
  RecruitmentApplicationNotFound,
  RecruitmentAssignmentCommandConflict,
  RecruitmentDecodeError,
  RecruitmentInactiveActor,
  RecruitmentInterviewerNotEligible,
  RecruitmentInterviewSchemaInactive,
  RecruitmentInterviewSchemaNotFound,
  RecruitmentInvalidContext,
  RecruitmentPersistenceError,
  RecruitmentRoleDenied,
  RecruitmentScopeDenied,
  InterviewQuestionsUnavailable,
} from "@vektorprogrammet/domain/recruitment";
import {
  InterviewQuestionDefinitionSchema,
  type InterviewQuestionDefinition,
  RecruitmentInterviewQuestionSourceSchema,
  RecruitmentInterviewQuestionSnapshot,
  InterviewSchema,
  InterviewSchemaId,
  type InterviewSchemaValue,
  RecruitmentActorSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentAssignmentCandidateSchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentAssignmentResultSchema,
  RecruitmentInterview,
  type RecruitmentInterviewValue,
  RecruitmentInterviewId,
  isRecruitmentNow,
  type RecruitmentActor,
  type RecruitmentAssignmentBoard,
  type RecruitmentAssignmentBoardQuery,
  type RecruitmentAssignmentCandidate,
  type RecruitmentAssignmentCommand,
  type RecruitmentAssignmentContext,
  type RecruitmentAssignmentObservation,
  type RecruitmentAssignmentResult,
  RecruitmentInterviewerOptionSchema,
  type RecruitmentInterviewSchemaOption,
  type RecruitmentInterviewerOption,
  type RecruitmentReadAssignmentBoardContext,
} from "@vektorprogrammet/domain/recruitment";
import { personProfileDisplayName } from "@vektorprogrammet/domain/profile";
import type { RecruitmentFailure } from "@vektorprogrammet/domain/recruitment";

type DepartmentLeaderActor = Extract<RecruitmentActor, { readonly _tag: "DepartmentLeader" }>;

type AuthorizedRecruitmentAssignmentContext = Omit<RecruitmentAssignmentContext, "actor"> & {
  readonly actor: DepartmentLeaderActor;
};

interface ApplicationBoardRow {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly departmentId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly submittedAt: string;
  readonly interviewId: string | null;
  readonly interviewerPersonId: string | null;
  readonly interviewSchemaId: string | null;
  readonly assignedByPersonId: string | null;
  readonly assignedAt: string | null;
  readonly scheduledAt: string | null;
  readonly interviewRevision: number | null;
}

interface InterviewSchemaRow {
  readonly interviewSchemaId: string;
  readonly name: string;
  readonly questionCount: number;
  readonly active: boolean;
  readonly revision: number;
}

interface InterviewQuestionRow {
  readonly questionId: string;
  readonly ordinal: number;
  readonly prompt: string;
  readonly helpText: string | null;
  readonly kind: string;
  readonly alternatives: unknown;
}

interface StoredReceiptRow {
  readonly commandSha256: string;
  readonly applicationId: string;
  readonly interviewId: string;
  readonly observationJson: unknown;
}

interface StoredInterviewRow {
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

interface AssignmentApplicationRow {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly admissionPeriodId: string;
  readonly departmentId: string;
}

const ApplicationBoardRowSchema = Schema.Struct({
  applicationId: Schema.String,
  departmentId: Schema.String,
  applicantId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  email: Schema.String,
  submittedAt: Schema.String,
  interviewId: Schema.NullOr(Schema.String),
  interviewerPersonId: Schema.NullOr(Schema.String),
  interviewSchemaId: Schema.NullOr(Schema.String),
  assignedByPersonId: Schema.NullOr(Schema.String),
  assignedAt: Schema.NullOr(Schema.String),
  scheduledAt: Schema.NullOr(Schema.String),
  interviewRevision: Schema.NullOr(Schema.Number),
});

const InterviewSchemaRowSchema = Schema.Struct({
  interviewSchemaId: Schema.String,
  name: Schema.String,
  questionCount: Schema.Number,
  active: Schema.Boolean,
  revision: Schema.Number,
});

const InterviewQuestionRowSchema = Schema.Struct({
  questionId: Schema.String,
  ordinal: Schema.Number,
  prompt: Schema.String,
  helpText: Schema.NullOr(Schema.String),
  kind: Schema.String,
  alternatives: Schema.Unknown,
});

const StoredReceiptRowSchema = Schema.Struct({
  commandSha256: Schema.String,
  applicationId: Schema.String,
  interviewId: Schema.String,
  observationJson: Schema.Unknown,
});

const StoredInterviewRowSchema = Schema.Struct({
  interviewId: Schema.String,
  applicationId: Schema.String,
  departmentId: Schema.String,
  interviewerPersonId: Schema.String,
  coInterviewerPersonId: Schema.NullOr(Schema.String),
  interviewSchemaId: Schema.String,
  assignedByPersonId: Schema.String,
  assignedAt: Schema.String,
  revision: Schema.Number,
});

const AssignmentApplicationRowSchema = Schema.Struct({
  applicationId: Schema.String,
  applicantId: Schema.String,
  admissionPeriodId: Schema.String,
  departmentId: Schema.String,
});

const persistenceError = (operation: string, cause?: unknown): RecruitmentPersistenceError =>
  new RecruitmentPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : "recruitment persistence failed",
  });

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

const decodeQuery = (
  query: RecruitmentAssignmentBoardQuery,
): Effect.Effect<RecruitmentAssignmentBoardQuery, RecruitmentDecodeError> =>
  decode(RecruitmentAssignmentBoardQuerySchema, "assignment board query")(query);

const decodeCommand = (
  command: RecruitmentAssignmentCommand,
): Effect.Effect<RecruitmentAssignmentCommand, RecruitmentDecodeError> =>
  decode(RecruitmentAssignmentCommandSchema, "assignment command")(command);

const checkContext = (
  actor: RecruitmentActor,
  now: string,
  interviewId?: RecruitmentInterviewId,
): Effect.Effect<DepartmentLeaderActor, RecruitmentFailure> =>
  Effect.gen(function* () {
    if (!actor.active) return yield* new RecruitmentInactiveActor({ personId: actor.personId });

    if (!Predicate.isTagged(actor, "DepartmentLeader")) {
      return yield* new RecruitmentRoleDenied({ personId: actor.personId });
    }

    if (!isRecruitmentNow(now)) {
      return yield* new RecruitmentInvalidContext({ message: "now must be an RFC3339 instant" });
    }

    if (interviewId !== undefined && interviewId.trim().length === 0) {
      return yield* new RecruitmentInvalidContext({ message: "interviewId must be non-empty" });
    }

    return actor;
  });

const currentPeriod = (
  admissions: AdmissionsOperations,
  departmentId: DepartmentId,
  now: string,
): Effect.Effect<AdmissionPeriodProjection, RecruitmentFailure> =>
  Effect.gen(function* () {
    const periods = yield* admissions.listOpenAdmissionPeriods(now);
    const scoped = periods.filter((period) => period.departmentId === departmentId);

    if (scoped.length === 0) {
      return yield* new RecruitmentAdmissionPeriodNotFound({ departmentId });
    }

    if (scoped.length > 1) {
      return yield* new RecruitmentAmbiguousAdmissionPeriod({ departmentId });
    }

    return scoped[0]!;
  });

const membershipActiveAt = (membership: Membership, now: string): boolean =>
  compareRfc3339Instants(membership.startAt, now) <= 0 &&
  (membership.endAt === null || compareRfc3339Instants(now, membership.endAt) < 0) &&
  !membership.isSuspended;

const liveInterviewerIds = (
  organization: OrganizationOperations,
  departmentId: DepartmentId,
  now: string,
): Effect.Effect<ReadonlyArray<PersonId>, RecruitmentFailure> =>
  Effect.gen(function* () {
    const teams = yield* organization.listTeams(departmentId);
    const ids = new Set<PersonId>();

    for (const team of teams) {
      if (!team.active) continue;
      const memberships = yield* organization.listMembershipsForTeam(team.teamId);

      for (const membership of memberships) {
        if (membershipActiveAt(membership, now)) ids.add(membership.personId);
      }
    }

    return [...ids].sort();
  });

const interviewerOptions = (
  organization: OrganizationOperations,
  profile: ProfileOperations,
  departmentId: DepartmentId,
  now: string,
): Effect.Effect<ReadonlyArray<RecruitmentInterviewerOption>, RecruitmentFailure> =>
  Effect.gen(function* () {
    const ids = yield* liveInterviewerIds(organization, departmentId, now);
    const profiles = yield* profile.readProfiles(ids);
    const options: RecruitmentInterviewerOption[] = [];

    for (const item of profiles) {
      const option = yield* decode(
        RecruitmentInterviewerOptionSchema,
        "interviewer option",
      )({ personId: item.personId, displayName: personProfileDisplayName(item) });

      options.push(option);
    }

    return options.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.personId.localeCompare(right.personId),
    );
  });

const readInterviewSchemas = (
  sql: DatabaseOperations,
): Effect.Effect<ReadonlyArray<RecruitmentInterviewSchemaOption>, RecruitmentFailure> =>
  Effect.gen(function* () {
    const rows = yield* sql<InterviewSchemaRow>`
      SELECT
        interview_schema_id AS "interviewSchemaId",
        name,
        question_count AS "questionCount",
        active,
        revision
      FROM recruitment_interview_schemas
      ORDER BY name ASC, interview_schema_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read interview schemas", cause)),
      ),
    );

    const options: RecruitmentInterviewSchemaOption[] = [];

    for (const row of rows) {
      const decodedRow = yield* decode(InterviewSchemaRowSchema, "interview schema row")(row);
      const schema = yield* decode(InterviewSchema, "interview schema")(decodedRow);
      options.push({
        interviewSchemaId: schema.interviewSchemaId,
        name: schema.name,
        questionCount: schema.questionCount,
        active: schema.active,
        revision: schema.revision,
      });
    }

    return options;
  });

const readBoardRows = (
  sql: DatabaseOperations,
  periodId: string,
  departmentId: DepartmentId,
): Effect.Effect<ReadonlyArray<ApplicationBoardRow>, RecruitmentFailure> =>
  sql<ApplicationBoardRow>`
    SELECT
      a.application_id AS "applicationId",
      a.applicant_id AS "applicantId",
      a.department_id AS "departmentId",
      p.first_name AS "firstName",
      p.last_name AS "lastName",
      p.email,
      to_char(a.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "submittedAt",
      i.interview_id AS "interviewId",
      i.interviewer_person_id AS "interviewerPersonId",
      i.interview_schema_id AS "interviewSchemaId",
      i.assigned_by_person_id AS "assignedByPersonId",
      CASE WHEN i.assigned_at IS NULL THEN NULL
        ELSE to_char(i.assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS "assignedAt",
      CASE WHEN s.scheduled_at IS NULL THEN NULL
        ELSE to_char(s.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS "scheduledAt",
      i.revision AS "interviewRevision"
    FROM admission_applications a
    INNER JOIN admission_applicants p ON p.applicant_id = a.applicant_id
    LEFT JOIN recruitment_interviews i ON i.application_id = a.application_id
    LEFT JOIN recruitment_interview_schedules s ON s.interview_id = i.interview_id
    WHERE a.admission_period_id = ${periodId}
      AND a.department_id = ${departmentId}
    ORDER BY a.submitted_at ASC, a.application_id ASC
  `.pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read assignment applications", cause)),
    ),
  );

const candidateForRow = (
  row: ApplicationBoardRow,
  profileById: ReadonlyMap<string, { readonly firstName: string; readonly lastName: string }>,
  schemaById: ReadonlyMap<string, RecruitmentInterviewSchemaOption>,
): Effect.Effect<RecruitmentAssignmentCandidate, RecruitmentFailure> =>
  Effect.gen(function* () {
    const decodedRow = yield* decode(ApplicationBoardRowSchema, "assignment application row")(row);

    const interviewer =
      decodedRow.interviewerPersonId === null
        ? null
        : (() => {
            const profile = profileById.get(decodedRow.interviewerPersonId);

            return profile === undefined
              ? null
              : {
                  personId: PersonId.make(decodedRow.interviewerPersonId),
                  displayName: personProfileDisplayName(profile),
                };
          })();

    const interviewSchema =
      decodedRow.interviewSchemaId === null
        ? null
        : (schemaById.get(decodedRow.interviewSchemaId) ?? null);

    const candidate = {
      applicationId: decodedRow.applicationId,
      applicantId: decodedRow.applicantId,
      firstName: decodedRow.firstName,
      lastName: decodedRow.lastName,
      email: decodedRow.email,
      submittedAt: decodedRow.submittedAt,
      applicationState: "Received" as const,
      interviewState:
        decodedRow.interviewId === null
          ? "Unassigned"
          : decodedRow.scheduledAt === null
            ? "NoContact"
            : "Scheduled",
      interviewer,
      interviewSchema,
      scheduledAt: decodedRow.scheduledAt,
    };

    return yield* decode(RecruitmentAssignmentCandidateSchema, "assignment candidate")(candidate);
  });

const assignmentBoard = (
  query: RecruitmentAssignmentBoardQuery,
  context: RecruitmentReadAssignmentBoardContext,
  sql: DatabaseOperations,
  admissions: AdmissionsOperations,
  organization: OrganizationOperations,
  profile: ProfileOperations,
): Effect.Effect<RecruitmentAssignmentBoard, RecruitmentFailure> =>
  Effect.gen(function* () {
    const decodedQuery = yield* decodeQuery(query);
    const actor = yield* checkContext(context.actor, context.now);
    const period = yield* currentPeriod(admissions, actor.departmentId, context.now);

    const interviewers = yield* interviewerOptions(
      organization,
      profile,
      actor.departmentId,
      context.now,
    );

    const allSchemas = yield* readInterviewSchemas(sql);
    const schemas = allSchemas.filter((schema) => schema.active);
    const rows = yield* readBoardRows(sql, period.id, actor.departmentId);
    const personIds = new Set<string>(interviewers.map((item) => item.personId));

    for (const row of rows)
      if (row.interviewerPersonId !== null) personIds.add(row.interviewerPersonId);
    const profiles = yield* profile.readProfiles([...personIds].map((id) => PersonId.make(id)));
    const profileById = new Map(profiles.map((item) => [item.personId, item]));
    const schemaById = new Map(allSchemas.map((item) => [item.interviewSchemaId, item]));
    const candidates: RecruitmentAssignmentCandidate[] = [];

    for (const row of rows) {
      if (decodedQuery.status === "new" && row.interviewId !== null) continue;
      candidates.push(yield* candidateForRow(row, profileById, schemaById));
    }

    return yield* decode(
      RecruitmentAssignmentBoardSchema,
      "assignment board",
    )({
      admissionPeriodId: period.id,
      departmentId: period.departmentId,
      candidates,
      interviewers,
      interviewSchemas: schemas,
    });
  });

const readAssignmentApplication = (
  sql: DatabaseOperations,
  applicationId: string,
): Effect.Effect<AssignmentApplicationRow | undefined, RecruitmentFailure> =>
  sql<AssignmentApplicationRow>`
    SELECT
      application_id AS "applicationId",
      applicant_id AS "applicantId",
      admission_period_id AS "admissionPeriodId",
      department_id AS "departmentId"
    FROM admission_applications
    WHERE application_id = ${applicationId}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(AssignmentApplicationRowSchema, "assignment application")(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("lock assignment application", cause)),
    ),
  );

const readStoredReceipt = (
  sql: DatabaseOperations,
  commandId: string,
): Effect.Effect<StoredReceiptRow | undefined, RecruitmentFailure> =>
  sql<StoredReceiptRow>`
    SELECT
      command_sha256 AS "commandSha256",
      application_id AS "applicationId",
      interview_id AS "interviewId",
      observation_json AS "observationJson"
    FROM recruitment_assignment_command_receipts
    WHERE command_id = ${commandId}
    FOR SHARE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(StoredReceiptRowSchema, "assignment command receipt")(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read assignment receipt", cause)),
    ),
  );

const readInterviewForApplication = (
  sql: DatabaseOperations,
  applicationId: string,
): Effect.Effect<StoredInterviewRow | undefined, RecruitmentFailure> =>
  sql<StoredInterviewRow>`
    SELECT
      interview_id AS "interviewId",
      application_id AS "applicationId",
      department_id AS "departmentId",
      interviewer_person_id AS "interviewerPersonId",
      co_interviewer_person_id AS "coInterviewerPersonId",
      interview_schema_id AS "interviewSchemaId",
      assigned_by_person_id AS "assignedByPersonId",
      to_char(assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "assignedAt",
      revision
    FROM recruitment_interviews
    WHERE application_id = ${applicationId}
    FOR SHARE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(StoredInterviewRowSchema, "stored recruitment interview")(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read application interview", cause)),
    ),
  );

const readInterviewSchema = (
  sql: DatabaseOperations,
  interviewSchemaId: string,
): Effect.Effect<InterviewSchemaValue | undefined, RecruitmentFailure> =>
  sql<InterviewSchemaRow>`
    SELECT
      interview_schema_id AS "interviewSchemaId",
      name,
      question_count AS "questionCount",
      active,
      revision
    FROM recruitment_interview_schemas
    WHERE interview_schema_id = ${interviewSchemaId}
    FOR SHARE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(undefined)
        : decode(
            InterviewSchemaRowSchema,
            "interview schema row",
          )(rows[0]).pipe(
            Effect.flatMap((row) => decode(InterviewSchema, "interview schema")(row)),
          ),
    ),

    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read interview schema", cause)),
    ),
  );

const questionsUnavailable = (
  interviewSchemaId: string,
  reason: string,
): InterviewQuestionsUnavailable =>
  new InterviewQuestionsUnavailable({
    interviewSchemaId: InterviewSchemaId.make(interviewSchemaId),
    reason,
  });

const readQuestionSource = (
  sql: DatabaseOperations,
  interviewSchemaId: string,
  questionCount: number,
): Effect.Effect<ReadonlyArray<InterviewQuestionDefinition>, RecruitmentFailure> =>
  sql<InterviewQuestionRow>`
    SELECT
      question_id AS "questionId",
      ordinal,
      prompt,
      help_text AS "helpText",
      kind,
      alternatives
    FROM public.recruitment_interview_schema_questions
    WHERE interview_schema_id = ${interviewSchemaId}
    ORDER BY ordinal
    FOR SHARE
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.gen(function* () {
        if (rows.length !== questionCount) {
          return yield* questionsUnavailable(
            interviewSchemaId,
            `expected ${questionCount} questions but found ${rows.length}`,
          );
        }

        const questions: Array<InterviewQuestionDefinition> = [];

        for (const row of rows) {
          const decodedRow = yield* decode(
            InterviewQuestionRowSchema,
            "interview question source row",
          )(row).pipe(
            Effect.mapError(() =>
              questionsUnavailable(interviewSchemaId, "invalid question source row"),
            ),
          );

          const question = yield* decode(
            InterviewQuestionDefinitionSchema,
            "interview question definition",
          )(decodedRow).pipe(
            Effect.mapError(() =>
              questionsUnavailable(interviewSchemaId, "invalid question definition"),
            ),
          );

          questions.push(question);
        }

        return yield* decode(
          RecruitmentInterviewQuestionSourceSchema,
          "interview question source",
        )(questions).pipe(
          Effect.mapError(() =>
            questionsUnavailable(interviewSchemaId, "question source is not complete"),
          ),
        );
      }),
    ),
    Effect.catchTag("SqlError", () =>
      Effect.fail(questionsUnavailable(interviewSchemaId, "question source unavailable")),
    ),
  );

const readQuestionSnapshotCount = (
  sql: DatabaseOperations,
  interviewId: string,
): Effect.Effect<number, RecruitmentFailure> =>
  sql<{ readonly interviewId: string }>`
    SELECT interview_id AS "interviewId"
    FROM public.recruitment_interview_question_snapshots
    WHERE interview_id = ${interviewId}
    ORDER BY ordinal
    FOR SHARE
  `.pipe(
    Effect.map((rows) => rows.length),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read interview question snapshot count", cause)),
    ),
  );

const writeQuestionSnapshots = (
  sql: DatabaseOperations,
  interview: RecruitmentInterviewValue,
  questions: ReadonlyArray<InterviewQuestionDefinition>,
): Effect.Effect<void, RecruitmentFailure> =>
  Effect.gen(function* () {
    for (const question of questions) {
      const snapshot = yield* decode(
        RecruitmentInterviewQuestionSnapshot,
        "interview question snapshot",
      )({
        interviewId: interview.interviewId,
        questionId: question.questionId,
        ordinal: question.ordinal,
        prompt: question.prompt,
        helpText: question.helpText,
        kind: question.kind,
        alternatives: question.alternatives,
      });

      yield* sql`
        INSERT INTO public.recruitment_interview_question_snapshots (
          interview_id,
          question_id,
          ordinal,
          prompt,
          help_text,
          kind,
          alternatives
        ) VALUES (
          ${snapshot.interviewId},
          ${snapshot.questionId},
          ${snapshot.ordinal},
          ${snapshot.prompt},
          ${snapshot.helpText},
          ${snapshot.kind},
          ${canonicalJson(snapshot.alternatives)}::jsonb
        )
      `.pipe(
        Effect.asVoid,
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("insert interview question snapshot", cause)),
        ),
      );
    }
  });

const buildInterview = (
  row: StoredInterviewRow,
): Effect.Effect<RecruitmentInterviewValue, RecruitmentFailure> =>
  decode(
    RecruitmentInterview,
    "recruitment interview",
  )({
    interviewId: row.interviewId,
    applicationId: row.applicationId,
    departmentId: row.departmentId,
    interviewerPersonId: row.interviewerPersonId,
    coInterviewerPersonId: row.coInterviewerPersonId,
    interviewSchemaId: row.interviewSchemaId,
    assignedByPersonId: row.assignedByPersonId,
    assignedAt: row.assignedAt,
    revision: row.revision,
  });

const writeInterview = (
  sql: DatabaseOperations,
  command: RecruitmentAssignmentCommand,
  context: AuthorizedRecruitmentAssignmentContext,
): Effect.Effect<RecruitmentInterviewValue, RecruitmentFailure> =>
  sql<StoredInterviewRow>`
    INSERT INTO recruitment_interviews (
      interview_id,
      application_id,
      department_id,
      interviewer_person_id,
      interview_schema_id,
      assigned_by_person_id,
      assigned_at,
      revision
    ) VALUES (
      ${context.interviewId},
      ${command.applicationId},
      ${context.actor.departmentId},
      ${command.interviewerPersonId},
      ${command.interviewSchemaId},
      ${context.actor.personId},
      ${context.now},
      0
    )
    RETURNING
      interview_id AS "interviewId",
      application_id AS "applicationId",
      department_id AS "departmentId",
      interviewer_person_id AS "interviewerPersonId",
      co_interviewer_person_id AS "coInterviewerPersonId",
      interview_schema_id AS "interviewSchemaId",
      assigned_by_person_id AS "assignedByPersonId",
      to_char(assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "assignedAt",
      revision
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(persistenceError("insert recruitment interview"))
        : decode(
            StoredInterviewRowSchema,
            "inserted recruitment interview",
          )(rows[0]).pipe(Effect.flatMap(buildInterview)),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("insert recruitment interview", cause)),
    ),
  );

const writeReceipt = (
  sql: DatabaseOperations,
  command: RecruitmentAssignmentCommand,
  observation: RecruitmentAssignmentObservation,
  interview: RecruitmentInterviewValue,
  now: string,
  digest: string,
): Effect.Effect<void, RecruitmentPersistenceError> =>
  sql`
    INSERT INTO recruitment_assignment_command_receipts (
      command_id, command_sha256, command_json, observation_json,
      application_id, interview_id, committed_at
    ) VALUES (
      ${command.commandId},
      ${digest},
      ${sql.json(canonicalJsonValue(JSON.parse(canonicalJson(command))))},
      ${sql.json(canonicalJsonValue(observation))},
      ${interview.applicationId},
      ${interview.interviewId},
      ${now}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("write assignment receipt", cause)),
    ),
  );

const writeAudit = (
  sql: DatabaseOperations,
  command: RecruitmentAssignmentCommand,
  interview: RecruitmentInterviewValue,
  now: string,
): Effect.Effect<void, RecruitmentPersistenceError> =>
  sql`
    INSERT INTO recruitment_assignment_audit (
      command_id,
      interview_id,
      application_id,
      department_id,
      actor_person_id,
      action,
      interview_revision,
      occurred_at
    ) VALUES (
      ${command.commandId},
      ${interview.interviewId},
      ${interview.applicationId},
      ${interview.departmentId},
      ${interview.assignedByPersonId},
      'ApplicantAssigned',
      ${interview.revision},
      ${now}
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("write assignment audit", cause)),
    ),
  );

const assignmentInTransaction = (
  command: RecruitmentAssignmentCommand,
  context: AuthorizedRecruitmentAssignmentContext,
  sql: DatabaseOperations,
  admissions: AdmissionsOperations,
  organization: OrganizationOperations,
  profile: ProfileOperations,
  digest: string,
): Effect.Effect<RecruitmentAssignmentResult, RecruitmentFailure> =>
  Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.applicationId}, 0))`.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("lock assignment application", cause)),
      ),
    );
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${command.commandId}, 0))`.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("lock assignment command", cause)),
      ),
    );
    const application = yield* readAssignmentApplication(sql, command.applicationId);

    if (application === undefined) {
      return yield* new RecruitmentApplicationNotFound({ applicationId: command.applicationId });
    }

    if (application.departmentId !== context.actor.departmentId) {
      return yield* new RecruitmentScopeDenied({
        personId: context.actor.personId,
        departmentId: DepartmentId.make(application.departmentId),
        applicationId: command.applicationId,
      });
    }

    const period = yield* currentPeriod(admissions, context.actor.departmentId, context.now);

    if (application.admissionPeriodId !== period.id) {
      return yield* new RecruitmentScopeDenied({
        personId: context.actor.personId,
        departmentId: context.actor.departmentId,
        applicationId: command.applicationId,
      });
    }

    const storedReceipt = yield* readStoredReceipt(sql, command.commandId);

    if (storedReceipt !== undefined) {
      if (storedReceipt.applicationId !== command.applicationId) {
        return yield* persistenceError("validate assignment receipt application linkage");
      }

      if (storedReceipt.commandSha256 !== digest) {
        return yield* new RecruitmentAssignmentCommandConflict({ commandId: command.commandId });
      }

      const observation = yield* decode(
        RecruitmentAssignmentObservationSchema,
        "stored assignment observation",
      )(storedReceipt.observationJson);

      if (
        observation.interview.applicationId !== storedReceipt.applicationId ||
        observation.interview.interviewId !== storedReceipt.interviewId ||
        observation.interview.departmentId !== application.departmentId
      ) {
        return yield* persistenceError("validate assignment receipt observation linkage");
      }

      return yield* decode(
        RecruitmentAssignmentResultSchema,
        "assignment replay result",
      )({ observation, replayed: true });
    }

    const existing = yield* readInterviewForApplication(sql, command.applicationId);
    const interviewSchema = yield* readInterviewSchema(sql, command.interviewSchemaId);

    if (interviewSchema === undefined) {
      return yield* new RecruitmentInterviewSchemaNotFound({
        interviewSchemaId: command.interviewSchemaId,
      });
    }

    if (!interviewSchema.active) {
      return yield* new RecruitmentInterviewSchemaInactive({
        interviewSchemaId: command.interviewSchemaId,
      });
    }

    if (existing !== undefined) {
      const existingSchema = yield* readInterviewSchema(sql, existing.interviewSchemaId);

      if (existingSchema === undefined) {
        return yield* questionsUnavailable(
          existing.interviewSchemaId,
          "assigned interview references a missing schema",
        );
      }

      const existingQuestions = yield* readQuestionSource(
        sql,
        existing.interviewSchemaId,
        existingSchema.questionCount,
      );

      const snapshotCount = yield* readQuestionSnapshotCount(sql, existing.interviewId);

      if (snapshotCount !== existingQuestions.length) {
        return yield* questionsUnavailable(
          existing.interviewSchemaId,
          "assigned interview has no complete question snapshot",
        );
      }

      return yield* new RecruitmentApplicationAlreadyAssigned({
        applicationId: command.applicationId,
        interviewId: RecruitmentInterviewId.make(existing.interviewId),
      });
    }

    const questions = yield* readQuestionSource(
      sql,
      command.interviewSchemaId,
      interviewSchema.questionCount,
    );

    const eligibleIds = yield* liveInterviewerIds(
      organization,
      context.actor.departmentId,
      context.now,
    );

    if (!eligibleIds.some((personId) => personId === command.interviewerPersonId)) {
      return yield* new RecruitmentInterviewerNotEligible({
        personId: command.interviewerPersonId,
        departmentId: context.actor.departmentId,
      });
    }

    yield* profile.readProfiles([command.interviewerPersonId]);
    const interview = yield* writeInterview(sql, command, context);
    yield* writeQuestionSnapshots(sql, interview, questions);

    const observation = yield* RecruitmentAssignmentObservationSchema.makeEffect({
      commandId: command.commandId,
      interview,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new RecruitmentDecodeError({
            message: cause instanceof Error ? cause.message : `invalid ${"assignment observation"}`,
          }),
      ),
    );

    yield* writeReceipt(sql, command, observation, interview, context.now, digest);
    yield* writeAudit(sql, command, interview, context.now);

    return yield* decode(
      RecruitmentAssignmentResultSchema,
      "assignment result",
    )({ observation, replayed: false });
  });

export const readAssignmentBoard = (
  query: RecruitmentAssignmentBoardQuery,
  context: RecruitmentReadAssignmentBoardContext,
): Effect.Effect<
  RecruitmentAssignmentBoard,
  RecruitmentFailure,
  Database | Admissions | Organization | Profile
> =>
  Effect.gen(function* () {
    const decodedContext = yield* decode(
      RecruitmentActorSchema,
      "recruitment actor",
    )(context.actor);

    const sql = yield* Database;
    const admissions = yield* Admissions;
    const organization = yield* Organization;
    const profile = yield* Profile;

    return yield* assignmentBoard(
      query,
      { actor: decodedContext, now: context.now },
      sql,
      admissions,
      organization,
      profile,
    );
  });

export const assignApplicant = (
  command: RecruitmentAssignmentCommand,
  context: RecruitmentAssignmentContext,
): Effect.Effect<
  RecruitmentAssignmentResult,
  RecruitmentFailure,
  Database | Admissions | Organization | Profile
> =>
  Effect.gen(function* () {
    const decodedCommand = yield* decodeCommand(command);

    const decodedContext = yield* decode(
      RecruitmentActorSchema,
      "recruitment actor",
    )(context.actor);

    const actor = yield* checkContext(decodedContext, context.now, context.interviewId);
    const sql = yield* Database;
    const admissions = yield* Admissions;
    const organization = yield* Organization;
    const profile = yield* Profile;
    const digest = sha256Hex(canonicalJsonBytes(decodedCommand));

    return yield* sql
      .withTransaction(
        assignmentInTransaction(
          decodedCommand,
          { actor, now: context.now, interviewId: context.interviewId },
          sql,
          admissions,
          organization,
          profile,
          digest,
        ),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("assignment transaction", cause)),
        ),
      );
  });
