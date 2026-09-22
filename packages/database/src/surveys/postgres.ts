import { Effect, Schema } from "effect";
import type { DatabaseShape } from "../service.js";
import { Database } from "../service.js";
import {
  CloseSchoolSurveyCommand,
  CreateSchoolSurveyCommand,
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyAdminScope,
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SchoolSurveyResultsResource,
  SubmitSchoolSurveyResponseRequest,
  SurveyId,
  type CloseSchoolSurveyCommand as CloseSchoolSurveyCommandValue,
  type CreateSchoolSurveyCommand as CreateSchoolSurveyCommandValue,
  type NormalizedSchoolSurveyAnswer,
  type PreparedSchoolSurveyResponse,
  type SchoolSurveyAdminCatalogResource as SchoolSurveyAdminCatalogResourceValue,
  type SchoolSurveyAdminListResource as SchoolSurveyAdminListResourceValue,
  type SchoolSurveyAdminResource as SchoolSurveyAdminResourceValue,
  type SchoolSurveyAdminScope as SchoolSurveyAdminScopeValue,
  type SchoolSurveyAnswerInput,
  type SchoolSurveyFormResource as SchoolSurveyFormResourceValue,
  type SchoolSurveyResponseResource as SchoolSurveyResponseResourceValue,
  type SchoolSurveyResultsResource as SchoolSurveyResultsResourceValue,
  type SurveyResponseId,
} from "@vektorprogrammet/domain/surveys";
import type { OrganizationPersonAuthority } from "@vektorprogrammet/domain/organization";
import {
  SchoolSurveyCommandConflict,
  SchoolSurveyDecodeError,
  SchoolSurveyInvalidState,
  SchoolSurveyNotFound,
  SchoolSurveyPersistenceError,
  SchoolSurveyScopeInvalid,
  SchoolSurveyStaleRevision,
  SchoolSurveyValidationFailed,
  type SchoolSurveyFailure,
} from "@vektorprogrammet/domain/surveys";

interface SurveyRow {
  readonly surveyId: string;
  readonly departmentId: string;
  readonly semesterId: string;
  readonly semesterLabel: string;
  readonly title: string;
  readonly completionText: string;
}

interface QuestionRow {
  readonly questionId: string;
  readonly kind: string;
  readonly label: string;
  readonly help: string | null;
  readonly required: boolean;
  readonly position: number;
}

interface AlternativeRow {
  readonly questionId: string;
  readonly value: string;
  readonly position: number;
}

interface SchoolRow {
  readonly schoolId: number;
  readonly name: string;
}

interface ResponseRow {
  readonly responseId: string;
  readonly submittedAt: string;
}

interface AdminSurveyRow extends SurveyRow {
  readonly resultsVisibility: string;
  readonly state: string;
  readonly revision: number;
  readonly createdAt: string | null;
  readonly createdByPersonId: string | null;
  readonly closedAt: string | null;
  readonly closedByPersonId: string | null;
  readonly responseCount: number;
}

interface SurveyIdRow {
  readonly surveyId: string;
}

interface SurveyLifecycleRow {
  readonly state: "Open" | "Closed";
  readonly revision: number;
}

interface ScopeExistsRow {
  readonly exists: boolean;
}

interface AdminCatalogDepartmentRow {
  readonly departmentId: string;
  readonly name: string;
}

interface AdminCatalogSemesterRow {
  readonly departmentId: string;
  readonly semesterId: string;
  readonly startAt: string;
  readonly endAt: string;
}

interface SurveyResultResponseRow {
  readonly responseId: string;
  readonly schoolId: number;
  readonly name: string;
  readonly submittedAt: string;
}

interface SurveyResultAnswerRow {
  readonly responseId: string;
  readonly questionId: string;
  readonly answerValue: string | null;
  readonly answerValues: unknown;
}

interface StoredQuestion {
  readonly kind: "Text" | "List" | "Radio" | "Check";
  readonly questionId: string;
  readonly required: boolean;
  readonly position: number;
  readonly alternatives: ReadonlyArray<{ readonly value: string; readonly position: number }>;
}

interface LoadedSurvey {
  readonly form: SchoolSurveyFormResourceValue;
  readonly completionText: string;
  readonly departmentId: string;
  readonly questions: ReadonlyArray<StoredQuestion>;
}

const decodeError = (operation: string, cause: unknown): SchoolSurveyDecodeError =>
  new SchoolSurveyDecodeError({ operation, message: String(cause) });
const persistenceError = (operation: string, cause: unknown): SchoolSurveyPersistenceError =>
  new SchoolSurveyPersistenceError({ operation, message: String(cause) });
const validationFailure = (surveyId: string, field: string): SchoolSurveyValidationFailed =>
  new SchoolSurveyValidationFailed({ surveyId, field });

const decodeForm = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(SchoolSurveyFormResource)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => decodeError(operation, cause)));
const decodeResponse = (value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(SchoolSurveyResponseResource)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => decodeError(operation, cause)));
const decodeRequest = (value: unknown) =>
  Schema.decodeUnknownEffect(SubmitSchoolSurveyResponseRequest)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => decodeError("decode school-survey response request", cause)));

/** Reads one currently Open School survey and the exact eligible-school projection at this snapshot. */
const loadSchoolSurvey = (sql: DatabaseShape, surveyId: SurveyId) =>
  Effect.gen(function* () {
    const surveyRows = yield* sql<SurveyRow>`
      SELECT
        survey_id AS "surveyId",
        department_id AS "departmentId",
        semester_id AS "semesterId",
        semester_label AS "semesterLabel",
        title,
        completion_text AS "completionText"
      FROM public.native_survey_definitions
      WHERE survey_id = ${surveyId}
        AND target_audience = 'School'
        AND state = 'Open'
    `;
    const survey = surveyRows[0];
    if (survey === undefined) {
      return yield* Effect.fail(new SchoolSurveyNotFound({ surveyId: String(surveyId) }));
    }

    const questionRows = yield* sql<QuestionRow>`
      SELECT
        question_id AS "questionId",
        question_type AS kind,
        label,
        help_text AS help,
        required,
        position
      FROM public.school_survey_questions
      WHERE survey_id = ${surveyId}
      ORDER BY position ASC, question_id ASC
    `;
    const alternativeRows = yield* sql<AlternativeRow>`
      SELECT
        alternative.question_id AS "questionId",
        alternative.value,
        alternative.position
      FROM public.school_survey_question_alternatives AS alternative
      JOIN public.school_survey_questions AS question
        ON question.question_id = alternative.question_id
      WHERE question.survey_id = ${surveyId}
      ORDER BY alternative.question_id ASC, alternative.position ASC
    `;
    const alternativesByQuestion = new Map<string, Array<AlternativeRow>>();
    for (const alternative of alternativeRows) {
      const alternatives = alternativesByQuestion.get(alternative.questionId);
      if (alternatives === undefined) {
        alternativesByQuestion.set(alternative.questionId, [alternative]);
      } else {
        alternatives.push(alternative);
      }
    }

    const schoolRows = yield* sql<SchoolRow>`
      SELECT school.school_id::double precision AS "schoolId", school.name
      FROM public.schools_directory_schools AS school
      JOIN public.schools_directory_departments AS department
        ON department.school_id = school.school_id
      WHERE department.department_id = ${survey.departmentId}
        AND school.active
        AND EXISTS (
          SELECT 1
          FROM public.assistant_placements AS placement
          WHERE placement.school_id = school.school_id
            AND placement.department_id = ${survey.departmentId}
            AND placement.semester_id = ${survey.semesterId}
            AND placement.active
        )
      ORDER BY school.name ASC, school.school_id ASC
    `;

    const questions = questionRows.map((question) => {
      const alternatives = alternativesByQuestion.get(question.questionId) ?? [];
      if (question.kind === "Text") {
        return {
          kind: "Text" as const,
          questionId: question.questionId,
          label: question.label,
          help: question.help,
          required: question.required,
        };
      }
      return {
        kind: question.kind,
        questionId: question.questionId,
        label: question.label,
        help: question.help,
        required: question.required,
        alternatives: alternatives.map((alternative) => alternative.value),
      };
    });
    const form = yield* decodeForm(
      {
        surveyId: survey.surveyId,
        departmentId: survey.departmentId,
        semesterId: survey.semesterId,
        semesterLabel: survey.semesterLabel,
        title: survey.title,
        schools: schoolRows,
        questions,
      },
      "decode school-survey form",
    );
    const storedQuestions: Array<StoredQuestion> = questionRows.map((question) => ({
      kind: question.kind as StoredQuestion["kind"],
      questionId: question.questionId,
      required: question.required,
      position: question.position,
      alternatives: (alternativesByQuestion.get(question.questionId) ?? []).map((alternative) => ({
        value: alternative.value,
        position: alternative.position,
      })),
    }));
    return {
      form,
      completionText: survey.completionText,
      departmentId: survey.departmentId,
      questions: storedQuestions,
    } satisfies LoadedSurvey;
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read school survey", cause)),
    ),
  );

/** Normalizes trimming and every semantically unordered input before idempotency digesting. */
const normalizeAnswers = (
  surveyId: string,
  questions: ReadonlyArray<StoredQuestion>,
  answers: ReadonlyArray<SchoolSurveyAnswerInput>,
): Effect.Effect<ReadonlyArray<NormalizedSchoolSurveyAnswer>, SchoolSurveyValidationFailed> =>
  Effect.try({
    try: () => {
      const questionsById = new Map(questions.map((question) => [question.questionId, question]));
      const seenQuestionIds = new Set<string>();
      const normalizedByQuestion = new Map<string, NormalizedSchoolSurveyAnswer>();
      for (const [index, answer] of answers.entries()) {
        const questionId = String(answer.questionId);
        const question = questionsById.get(questionId);
        if (question === undefined || seenQuestionIds.has(questionId)) {
          throw validationFailure(surveyId, `answers[${index}].questionId`);
        }
        seenQuestionIds.add(questionId);
        if (answer.kind !== question.kind) {
          throw validationFailure(surveyId, `answers[${index}].kind`);
        }
        if (answer.kind === "Text") {
          const value = answer.value.trim();
          if (value === "") {
            if (question.required) {
              throw validationFailure(surveyId, `answers[${index}].value`);
            }
            continue;
          }
          normalizedByQuestion.set(questionId, {
            kind: "Text",
            questionId: answer.questionId,
            value,
          });
          continue;
        }
        if (answer.kind === "List" || answer.kind === "Radio") {
          const value = answer.value.trim();
          if (!question.alternatives.some((alternative) => alternative.value === value)) {
            throw validationFailure(surveyId, `answers[${index}].value`);
          }
          normalizedByQuestion.set(questionId, {
            kind: answer.kind,
            questionId: answer.questionId,
            value,
          });
          continue;
        }
        const selected = new Set(answer.values.map((value) => value.trim()));
        if (selected.size !== answer.values.length) {
          throw validationFailure(surveyId, `answers[${index}].values`);
        }
        if (selected.size === 0) {
          if (question.required) {
            throw validationFailure(surveyId, `answers[${index}].values`);
          }
          continue;
        }
        if (
          [...selected].some(
            (value) => !question.alternatives.some((alternative) => alternative.value === value),
          )
        ) {
          throw validationFailure(surveyId, `answers[${index}].values`);
        }
        normalizedByQuestion.set(questionId, {
          kind: "Check",
          questionId: answer.questionId,
          values: question.alternatives
            .filter((alternative) => selected.has(alternative.value))
            .sort((left, right) => left.position - right.position)
            .map((alternative) => alternative.value),
        });
      }
      for (const question of questions) {
        if (question.required && !normalizedByQuestion.has(question.questionId)) {
          throw validationFailure(surveyId, `question:${question.questionId}`);
        }
      }
      return [...questions]
        .sort((left, right) => left.position - right.position)
        .flatMap((question) => {
          const answer = normalizedByQuestion.get(question.questionId);
          return answer === undefined ? [] : [answer];
        });
    },
    catch: (cause) =>
      cause instanceof SchoolSurveyValidationFailed
        ? cause
        : validationFailure(surveyId, "answers"),
  });

/** Reads the public form using the caller's read-only transaction snapshot. */
export const readSchoolSurveyFormPostgres = (
  surveyId: SurveyId,
): Effect.Effect<SchoolSurveyFormResourceValue, SchoolSurveyFailure, Database> =>
  Database.use((sql) => loadSchoolSurvey(sql, surveyId).pipe(Effect.map(({ form }) => form)));

/** Validates current School survey eligibility and canonicalizes answers before a receipt can replay. */
export const prepareSchoolSurveyResponsePostgres = (input: {
  readonly surveyId: SurveyId;
  readonly request: unknown;
}): Effect.Effect<PreparedSchoolSurveyResponse, SchoolSurveyFailure, Database> =>
  Effect.gen(function* () {
    const request = yield* decodeRequest(input.request);
    const sql = yield* Database;
    const survey = yield* loadSchoolSurvey(sql, input.surveyId);
    if (!survey.form.schools.some((school) => school.schoolId === request.schoolId)) {
      return yield* Effect.fail(validationFailure(String(input.surveyId), "schoolId"));
    }
    const answers = yield* normalizeAnswers(
      String(input.surveyId),
      survey.questions,
      request.answers,
    );
    return {
      surveyId: input.surveyId,
      departmentId: survey.form.departmentId,
      completionText: survey.completionText,
      schoolId: request.schoolId,
      answers,
    } satisfies PreparedSchoolSurveyResponse;
  });

/** Inserts only an already prepared response in the surrounding serializable transaction. */
export const persistSchoolSurveyResponsePostgres = (input: {
  readonly responseId: SurveyResponseId;
  readonly prepared: PreparedSchoolSurveyResponse;
}): Effect.Effect<SchoolSurveyResponseResourceValue, SchoolSurveyFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const responseRows = yield* sql<ResponseRow>`
      WITH open_survey AS MATERIALIZED (
        SELECT survey_id, department_id
        FROM public.native_survey_definitions
        WHERE survey_id = ${input.prepared.surveyId}
          AND department_id = ${input.prepared.departmentId}
          AND target_audience = 'School'
          AND state = 'Open'
        FOR SHARE
      )
      INSERT INTO public.school_survey_responses (
        response_id,
        survey_id,
        department_id,
        school_id,
        submitted_at
      )
      SELECT
        ${input.responseId},
        open_survey.survey_id,
        open_survey.department_id,
        ${input.prepared.schoolId},
        transaction_timestamp()
      FROM open_survey
      RETURNING
        response_id AS "responseId",
        to_char(
          submitted_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "submittedAt"
    `;
    const response = responseRows[0];
    if (response === undefined) {
      return yield* Effect.fail(
        new SchoolSurveyNotFound({ surveyId: String(input.prepared.surveyId) }),
      );
    }
    yield* Effect.forEach(input.prepared.answers, (answer) =>
      answer.kind === "Check"
        ? sql`
            INSERT INTO public.school_survey_answers (
              response_id, survey_id, question_id, answer_value, answer_values
            ) VALUES (
              ${input.responseId}, ${input.prepared.surveyId}, ${answer.questionId}, NULL, ${JSON.stringify(answer.values)}::jsonb
            )
          `
        : sql`
            INSERT INTO public.school_survey_answers (
              response_id, survey_id, question_id, answer_value, answer_values
            ) VALUES (
              ${input.responseId}, ${input.prepared.surveyId}, ${answer.questionId}, ${answer.value}, NULL
            )
          `,
    );
    return yield* decodeResponse(
      { ...response, completionText: input.prepared.completionText },
      "decode created school-survey response",
    );
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("persist school-survey response", cause)),
    ),
  );

const StoredCheckAnswerValues = Schema.Array(Schema.String);

const readAdminSurveyWithSql = (
  sql: DatabaseShape,
  surveyId: SurveyId,
): Effect.Effect<SchoolSurveyAdminResourceValue, SchoolSurveyFailure> =>
  Effect.gen(function* () {
    const surveyRows = yield* sql<AdminSurveyRow>`
      SELECT
        definition.survey_id AS "surveyId",
        definition.department_id AS "departmentId",
        definition.semester_id AS "semesterId",
        definition.semester_label AS "semesterLabel",
        definition.title,
        definition.completion_text AS "completionText",
        definition.results_visibility AS "resultsVisibility",
        definition.state,
        definition.revision,
        to_char(
          definition.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "createdAt",
        definition.created_by_person_id AS "createdByPersonId",
        to_char(
          definition.closed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "closedAt",
        definition.closed_by_person_id AS "closedByPersonId",
        count(response.response_id)::integer AS "responseCount"
      FROM public.native_survey_definitions AS definition
      LEFT JOIN public.school_survey_responses AS response
        ON response.survey_id = definition.survey_id
      WHERE definition.survey_id = ${surveyId}
        AND definition.target_audience = 'School'
      GROUP BY
        definition.survey_id,
        definition.department_id,
        definition.semester_id,
        definition.semester_label,
        definition.title,
        definition.completion_text,
        definition.results_visibility,
        definition.state,
        definition.revision,
        definition.created_at,
        definition.created_by_person_id,
        definition.closed_at,
        definition.closed_by_person_id
    `;
    const survey = surveyRows[0];
    if (survey === undefined) {
      return yield* Effect.fail(new SchoolSurveyNotFound({ surveyId: String(surveyId) }));
    }
    const questionRows = yield* sql<QuestionRow>`
      SELECT
        question_id AS "questionId",
        question_type AS kind,
        label,
        help_text AS help,
        required,
        position
      FROM public.school_survey_questions
      WHERE survey_id = ${surveyId}
      ORDER BY position ASC, question_id ASC
    `;
    const alternativeRows = yield* sql<AlternativeRow>`
      SELECT
        alternative.question_id AS "questionId",
        alternative.value,
        alternative.position
      FROM public.school_survey_question_alternatives AS alternative
      INNER JOIN public.school_survey_questions AS question
        ON question.question_id = alternative.question_id
      WHERE question.survey_id = ${surveyId}
      ORDER BY alternative.question_id ASC, alternative.position ASC
    `;
    const alternativesByQuestion = new Map<string, Array<AlternativeRow>>();
    for (const alternative of alternativeRows) {
      const alternatives = alternativesByQuestion.get(alternative.questionId);
      if (alternatives === undefined) {
        alternativesByQuestion.set(alternative.questionId, [alternative]);
      } else {
        alternatives.push(alternative);
      }
    }
    const questions = questionRows.map((question) => {
      const alternatives = alternativesByQuestion.get(question.questionId) ?? [];
      if (question.kind === "Text") {
        return {
          kind: "Text" as const,
          questionId: question.questionId,
          label: question.label,
          help: question.help,
          required: question.required,
        };
      }
      return {
        kind: question.kind,
        questionId: question.questionId,
        label: question.label,
        help: question.help,
        required: question.required,
        alternatives: alternatives.map((alternative) => alternative.value),
      };
    });
    return yield* Schema.decodeUnknownEffect(SchoolSurveyAdminResource)(
      { ...survey, questions },
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode School-survey administration row", cause)));
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read School-survey administration", cause)),
    ),
  );

const validateAdminScopeWithSql = (
  sql: DatabaseShape,
  input: unknown,
): Effect.Effect<SchoolSurveyAdminScopeValue, SchoolSurveyFailure> =>
  Effect.gen(function* () {
    const scope = yield* Schema.decodeUnknownEffect(SchoolSurveyAdminScope)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => decodeError("decode School-survey administration scope", cause)));
    const rows = yield* sql<ScopeExistsRow>`
      SELECT EXISTS (
        SELECT 1
        FROM public.admission_periods
        WHERE department_id = ${scope.departmentId}
          AND semester_id = ${scope.semesterId}
      ) AS "exists"
    `;
    if (rows[0]?.exists !== true) {
      return yield* Effect.fail(
        new SchoolSurveyScopeInvalid({
          departmentId: String(scope.departmentId),
          semesterId: String(scope.semesterId),
        }),
      );
    }
    return scope;
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("validate School-survey administration scope", cause)),
    ),
  );

/** Reads management scopes that an already resolved current authority can operate. */
export const readSchoolSurveyAdminCatalogPostgres = (
  authority: OrganizationPersonAuthority,
): Effect.Effect<SchoolSurveyAdminCatalogResourceValue, SchoolSurveyFailure, Database> =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const departmentRows = yield* sql<AdminCatalogDepartmentRow>`
        SELECT department_id AS "departmentId", name
        FROM public.organization_departments AS department
        WHERE department.active
          AND EXISTS (
            SELECT 1
            FROM public.admission_periods AS period
            WHERE period.department_id = department.department_id
          )
        ORDER BY name ASC, department_id ASC
      `;
      const leaderDepartmentIds = new Set(
        authority.memberships
          .filter((membership) => membership.active && membership.teamLeader)
          .map((membership) => String(membership.departmentId)),
      );
      const departments =
        authority.globalAdministrator === "Active"
          ? departmentRows
          : departmentRows.filter((department) => leaderDepartmentIds.has(department.departmentId));
      const departmentIds = new Set(departments.map((department) => department.departmentId));
      const semesterRows = yield* sql<AdminCatalogSemesterRow>`
        SELECT
          period.department_id AS "departmentId",
          semester.semester_id AS "semesterId",
          to_char(
            semester.start_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS "startAt",
          to_char(
            semester.end_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS "endAt"
        FROM public.admission_periods AS period
        INNER JOIN public.admission_period_semesters AS semester
          ON semester.semester_id = period.semester_id
        INNER JOIN public.organization_departments AS department
          ON department.department_id = period.department_id
        WHERE department.active
        ORDER BY semester.start_at DESC, semester.semester_id ASC, period.department_id ASC
      `;
      const semesterById = new Map<string, AdminCatalogSemesterRow>();
      for (const semester of semesterRows) {
        if (departmentIds.has(semester.departmentId) && !semesterById.has(semester.semesterId)) {
          semesterById.set(semester.semesterId, semester);
        }
      }
      return yield* Schema.decodeUnknownEffect(SchoolSurveyAdminCatalogResource)(
        {
          departments,
          semesters: [...semesterById.values()].map(({ semesterId, startAt, endAt }) => ({
            semesterId,
            startAt,
            endAt,
          })),
        },
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError((cause) => decodeError("decode School-survey administration catalog", cause)));
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read School-survey administration catalog", cause)),
      ),
    ),
  );

/** Reads one School-survey definition without applying management authority itself. */
export const readSchoolSurveyAdminSurveyPostgres = (
  surveyId: SurveyId,
): Effect.Effect<SchoolSurveyAdminResourceValue, SchoolSurveyFailure, Database> =>
  Database.use((sql) => readAdminSurveyWithSql(sql, surveyId));

/** Lists one admission-backed School-survey owner scope in deterministic definition order. */
export const listSchoolSurveyAdminSurveysPostgres = (
  input: SchoolSurveyAdminScopeValue,
): Effect.Effect<SchoolSurveyAdminListResourceValue, SchoolSurveyFailure, Database> =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const scope = yield* validateAdminScopeWithSql(sql, input);
      const rows = yield* sql<SurveyIdRow>`
        SELECT survey_id AS "surveyId"
        FROM public.native_survey_definitions
        WHERE department_id = ${scope.departmentId}
          AND semester_id = ${scope.semesterId}
          AND target_audience = 'School'
        ORDER BY created_at ASC NULLS FIRST, survey_id ASC
      `;
      const surveys = yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(SurveyId)(row.surveyId).pipe(
          Effect.mapError((cause) => decodeError("decode School-survey list identity", cause)),
          Effect.flatMap((surveyId) => readAdminSurveyWithSql(sql, surveyId)),
        ),
      );
      return yield* Schema.decodeUnknownEffect(SchoolSurveyAdminListResource)(
        { ...scope, surveys },
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError((cause) => decodeError("decode School-survey administration list", cause)));
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("list School-survey administration", cause)),
      ),
    ),
  );

/** Inserts an Open School survey, server-derived child identities, and mandatory creation audit. */
export const createSchoolSurveyAdminSurveyPostgres = (
  input: CreateSchoolSurveyCommandValue,
): Effect.Effect<SchoolSurveyAdminResourceValue, SchoolSurveyFailure, Database> =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const command = yield* Schema.decodeUnknownEffect(CreateSchoolSurveyCommand)(input, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError((cause) => decodeError("decode School-survey create command", cause)));
      const scope = yield* validateAdminScopeWithSql(sql, {
        departmentId: command.request.departmentId,
        semesterId: command.request.semesterId,
      });
      const replayRows = yield* sql<SurveyIdRow>`
        SELECT survey_id AS "surveyId"
        FROM public.native_survey_definitions
        WHERE creation_command_id = ${command.commandId}
      `;
      const replay = replayRows[0];
      if (replay !== undefined) {
        if (replay.surveyId !== command.surveyId) {
          return yield* Effect.fail(
            new SchoolSurveyCommandConflict({ commandId: String(command.commandId) }),
          );
        }
        return yield* readAdminSurveyWithSql(sql, command.surveyId);
      }
      yield* sql`
        INSERT INTO public.native_survey_definitions (
          survey_id,
          department_id,
          semester_id,
          semester_label,
          title,
          completion_text,
          target_audience,
          state,
          results_visibility,
          revision,
          created_by_person_id,
          created_at,
          creation_command_id,
          closed_by_person_id,
          closed_at,
          close_command_id
        ) VALUES (
          ${command.surveyId},
          ${scope.departmentId},
          ${scope.semesterId},
          ${String(scope.semesterId)},
          ${command.request.title},
          ${command.request.completionText},
          'School',
          'Open',
          ${command.request.resultsVisibility},
          0,
          ${command.actorPersonId},
          ${command.occurredAt},
          ${command.commandId},
          NULL,
          NULL,
          NULL
        )
      `;
      yield* Effect.forEach(command.request.questions, (question, questionIndex) =>
        Effect.gen(function* () {
          const questionId = `${command.surveyId}_q_${questionIndex}`;
          yield* sql`
            INSERT INTO public.school_survey_questions (
              question_id,
              survey_id,
              question_type,
              label,
              help_text,
              required,
              position
            ) VALUES (
              ${questionId},
              ${command.surveyId},
              ${question.kind},
              ${question.label},
              ${question.help},
              ${question.required},
              ${questionIndex}
            )
          `;
          if (question.kind === "Text") return;
          yield* Effect.forEach(question.alternatives, (value, alternativeIndex) =>
            sql`
              INSERT INTO public.school_survey_question_alternatives (
                alternative_id,
                question_id,
                value,
                position
              ) VALUES (
                ${`${questionId}_a_${alternativeIndex}`},
                ${questionId},
                ${value},
                ${alternativeIndex}
              )
            `,
          );
        }),
      );
      const survey = yield* readAdminSurveyWithSql(sql, command.surveyId);
      yield* sql`
        INSERT INTO public.school_survey_audit (
          survey_id,
          department_id,
          actor_person_id,
          command_id,
          action,
          occurred_at,
          survey_revision,
          snapshot
        ) VALUES (
          ${survey.surveyId},
          ${survey.departmentId},
          ${command.actorPersonId},
          ${command.commandId},
          'Created',
          ${command.occurredAt},
          ${survey.revision},
          ${sql.json({ surveyId: survey.surveyId, state: survey.state, revision: survey.revision })}
        )
      `;
      return survey;
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("create School-survey administration", cause)),
      ),
    ),
  );

/** Closes an Open School survey exactly once and records its mandatory closure audit. */
export const closeSchoolSurveyAdminSurveyPostgres = (
  input: CloseSchoolSurveyCommandValue,
): Effect.Effect<SchoolSurveyAdminResourceValue, SchoolSurveyFailure, Database> =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const command = yield* Schema.decodeUnknownEffect(CloseSchoolSurveyCommand)(input, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError((cause) => decodeError("decode School-survey close command", cause)));
      const replayRows = yield* sql<SurveyIdRow>`
        SELECT survey_id AS "surveyId"
        FROM public.native_survey_definitions
        WHERE close_command_id = ${command.commandId}
      `;
      const replay = replayRows[0];
      if (replay !== undefined) {
        if (replay.surveyId !== command.surveyId) {
          return yield* Effect.fail(
            new SchoolSurveyCommandConflict({ commandId: String(command.commandId) }),
          );
        }
        return yield* readAdminSurveyWithSql(sql, command.surveyId);
      }
      const updated = yield* sql<SurveyLifecycleRow>`
        UPDATE public.native_survey_definitions
        SET
          state = 'Closed',
          revision = revision + 1,
          closed_by_person_id = ${command.actorPersonId},
          closed_at = ${command.occurredAt},
          close_command_id = ${command.commandId}
        WHERE survey_id = ${command.surveyId}
          AND target_audience = 'School'
          AND state = 'Open'
          AND revision = ${command.request.expectedRevision}
        RETURNING state, revision
      `;
      if (updated[0] === undefined) {
        const currentRows = yield* sql<SurveyLifecycleRow>`
          SELECT state, revision
          FROM public.native_survey_definitions
          WHERE survey_id = ${command.surveyId}
            AND target_audience = 'School'
        `;
        const current = currentRows[0];
        if (current === undefined) {
          return yield* Effect.fail(new SchoolSurveyNotFound({ surveyId: String(command.surveyId) }));
        }
        if (current.state === "Closed") {
          return yield* Effect.fail(
            new SchoolSurveyInvalidState({
              surveyId: String(command.surveyId),
              state: current.state,
            }),
          );
        }
        return yield* Effect.fail(
          new SchoolSurveyStaleRevision({
            surveyId: String(command.surveyId),
            expectedRevision: command.request.expectedRevision,
            actualRevision: current.revision,
          }),
        );
      }
      const survey = yield* readAdminSurveyWithSql(sql, command.surveyId);
      yield* sql`
        INSERT INTO public.school_survey_audit (
          survey_id,
          department_id,
          actor_person_id,
          command_id,
          action,
          occurred_at,
          survey_revision,
          snapshot
        ) VALUES (
          ${survey.surveyId},
          ${survey.departmentId},
          ${command.actorPersonId},
          ${command.commandId},
          'Closed',
          ${command.occurredAt},
          ${survey.revision},
          ${sql.json({ surveyId: survey.surveyId, state: survey.state, revision: survey.revision })}
        )
      `;
      return survey;
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("close School-survey administration", cause)),
      ),
    ),
  );

/** Reads response rows in submission order and answer cells in definition order. */
export const readSchoolSurveyAdminResultsPostgres = (
  surveyId: SurveyId,
): Effect.Effect<SchoolSurveyResultsResourceValue, SchoolSurveyFailure, Database> =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const survey = yield* readAdminSurveyWithSql(sql, surveyId);
      const responseRows = yield* sql<SurveyResultResponseRow>`
        SELECT
          response.response_id AS "responseId",
          school.school_id::integer AS "schoolId",
          school.name,
          to_char(
            response.submitted_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) AS "submittedAt"
        FROM public.school_survey_responses AS response
        INNER JOIN public.schools_directory_schools AS school
          ON school.school_id = response.school_id
        WHERE response.survey_id = ${surveyId}
        ORDER BY response.submitted_at ASC, response.response_id ASC
      `;
      const answerRows = yield* sql<SurveyResultAnswerRow>`
        SELECT
          answer.response_id AS "responseId",
          answer.question_id AS "questionId",
          answer.answer_value AS "answerValue",
          answer.answer_values AS "answerValues"
        FROM public.school_survey_answers AS answer
        INNER JOIN public.school_survey_responses AS response
          ON response.response_id = answer.response_id
        INNER JOIN public.school_survey_questions AS question
          ON question.question_id = answer.question_id
        WHERE response.survey_id = ${surveyId}
        ORDER BY response.response_id ASC, question.position ASC, question.question_id ASC
      `;
      const answersByResponse = new Map<
        string,
        Map<string, { readonly answerValue: string | null; readonly answerValues: ReadonlyArray<string> }>
      >();
      for (const answer of answerRows) {
        const answerValues =
          answer.answerValues === null
            ? []
            : yield* Schema.decodeUnknownEffect(StoredCheckAnswerValues)(answer.answerValues, {
                onExcessProperty: "error",
              }).pipe(
                Effect.mapError((cause) =>
                  decodeError("decode School-survey Check result values", cause),
                ),
              );
        const answersByQuestion = answersByResponse.get(answer.responseId);
        const stored = { answerValue: answer.answerValue, answerValues };
        if (answersByQuestion === undefined) {
          answersByResponse.set(answer.responseId, new Map([[answer.questionId, stored]]));
        } else {
          answersByQuestion.set(answer.questionId, stored);
        }
      }
      const responses = responseRows.map((response) => {
        const answersByQuestion = answersByResponse.get(response.responseId);
        return {
          school: { schoolId: response.schoolId, name: response.name },
          submittedAt: response.submittedAt,
          answers: survey.questions.map((question) => {
            const answer = answersByQuestion?.get(String(question.questionId));
            if (question.kind === "Check") {
              return {
                kind: "Check" as const,
                questionId: question.questionId,
                values: answer?.answerValues ?? [],
              };
            }
            return {
              kind: question.kind,
              questionId: question.questionId,
              value: answer?.answerValue ?? null,
            };
          }),
        };
      });
      const responseCount = responseRows.length;
      return yield* Schema.decodeUnknownEffect(SchoolSurveyResultsResource)(
        {
          survey: { ...survey, responseCount },
          responseCount,
          responses,
        },
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError((cause) => decodeError("decode School-survey administration results", cause)));
    }).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read School-survey administration results", cause)),
      ),
    ),
  );
