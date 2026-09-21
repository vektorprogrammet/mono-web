import { Effect, Schema } from "effect";
import type { DatabaseShape } from "../database/service.js";
import { Database } from "../database/service.js";
import {
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SubmitSchoolSurveyResponseRequest,
  type NormalizedSchoolSurveyAnswer,
  type PreparedSchoolSurveyResponse,
  type SchoolSurveyAnswerInput,
  type SchoolSurveyFormResource as SchoolSurveyFormResourceValue,
  type SchoolSurveyResponseResource as SchoolSurveyResponseResourceValue,
  type SurveyId,
  type SurveyResponseId,
} from "./schema.js";
import {
  SchoolSurveyDecodeError,
  SchoolSurveyNotFound,
  SchoolSurveyPersistenceError,
  SchoolSurveyValidationFailed,
  type SchoolSurveyFailure,
} from "./errors.js";

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

/** Reads one imported School survey and the exact eligible-school projection at this snapshot. */
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
      INSERT INTO public.school_survey_responses (
        response_id,
        survey_id,
        department_id,
        school_id,
        submitted_at
      ) VALUES (
        ${input.responseId},
        ${input.prepared.surveyId},
        ${input.prepared.departmentId},
        ${input.prepared.schoolId},
        transaction_timestamp()
      )
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
        persistenceError("insert school-survey response", "insert did not return a response"),
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
