import { Schema } from "effect";
import { DepartmentId, PersonId, SemesterId } from "../organization/schema.js";
import { SchoolId, SchoolName } from "../schools/schema.js";
import { Rfc3339InstantSchema } from "../time.js";

const utf8ByteLength = (value: string): number => {
  let length = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }

  return length;
};

const databaseTrim = (value: string): string => value.replace(/^ +| +$/gu, "");

const boundedDatabaseText = (maximumBytes: number, message: string) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => utf8ByteLength(databaseTrim(value)) <= maximumBytes, {
        message,
      }),
    ),
  );

const boundedTrimmedText = (maximumBytes: number, message: string) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => utf8ByteLength(value.trim()) <= maximumBytes, { message }),
    ),
  );

const boundedIdentifier = (maximumBytes: number, message: string) =>
  boundedDatabaseText(maximumBytes, message).pipe(
    Schema.check(
      Schema.makeFilter((value) => value.length > 0 && databaseTrim(value) === value, {
        message: "a database-trimmed non-empty identifier",
      }),
    ),
  );

const boundedImportedText = (maximumBytes: number, message: string) =>
  boundedDatabaseText(maximumBytes, message).pipe(
    Schema.check(
      Schema.makeFilter(
        (value) => databaseTrim(value).length > 0 && databaseTrim(value) === value,
        { message: "a database-trimmed non-empty imported string" },
      ),
    ),
  );

const boundedArray = <S extends Schema.Top>(schema: S, maximum: number, message: string) =>
  Schema.Array(schema).pipe(
    Schema.check(Schema.makeFilter((value) => value.length <= maximum, { message })),
  );

export const SURVEY_IDENTIFIER_MAX_UTF8_BYTES = 128;

/** Opaque imported survey identity. */
export const SurveyId = boundedIdentifier(
  SURVEY_IDENTIFIER_MAX_UTF8_BYTES,
  "a survey ID at most 128 UTF-8 bytes",
).pipe(
  Schema.check(
    Schema.makeFilter((value) => value !== "." && value !== "..", {
      message: "a survey ID other than a URL dot segment",
    }),
  ),
  Schema.brand("SurveyId"),
);

export type SurveyId = typeof SurveyId.Type;

/** Opaque imported survey-question identity. */
export const SurveyQuestionId = boundedIdentifier(
  SURVEY_IDENTIFIER_MAX_UTF8_BYTES,
  "a survey question ID at most 128 UTF-8 bytes",
).pipe(Schema.brand("SurveyQuestionId"));

export type SurveyQuestionId = typeof SurveyQuestionId.Type;

/** Opaque server-issued anonymous response identity. */
export const SurveyResponseId = boundedIdentifier(
  SURVEY_IDENTIFIER_MAX_UTF8_BYTES,
  "a survey response ID at most 128 UTF-8 bytes",
).pipe(Schema.brand("SurveyResponseId"));

export type SurveyResponseId = typeof SurveyResponseId.Type;

export const SchoolSurveyQuestionKind = Schema.Literals(["Text", "List", "Radio", "Check"]);

const AnswerAlternative = boundedTrimmedText(500, "an alternative at most 500 UTF-8 bytes");

export type SchoolSurveyQuestionKind = typeof SchoolSurveyQuestionKind.Type;

const QuestionLabel = boundedImportedText(1_000, "a question label at most 1000 UTF-8 bytes");

const HelpText = boundedImportedText(1_000, "help text at most 1000 UTF-8 bytes");

const Alternative = boundedImportedText(500, "an alternative at most 500 UTF-8 bytes");

const SemesterLabel = boundedImportedText(100, "a semester label at most 100 UTF-8 bytes");

const SurveyTitle = boundedImportedText(255, "a title at most 255 UTF-8 bytes");

const CompletionText = boundedDatabaseText(4_096, "completion text at most 4096 UTF-8 bytes");

const AnswerText = boundedTrimmedText(4_096, "an answer at most 4096 UTF-8 bytes");

const CreateCompletionText = CompletionText.pipe(
  Schema.check(
    Schema.makeFilter((value) => databaseTrim(value).length > 0 && databaseTrim(value) === value, {
      message: "a database-trimmed non-empty completion text",
    }),
  ),
);

const Alternatives = boundedArray(Alternative, 100, "at most 100 alternatives");

const QuestionBase = {
  questionId: SurveyQuestionId,
  label: QuestionLabel,
  help: Schema.NullOr(HelpText),
  required: Schema.Boolean,
} as const;

/** Strict public Text-question projection. */
export const SchoolSurveyTextQuestion = Schema.Struct({
  kind: Schema.Literal("Text"),
  ...QuestionBase,
}).annotate({ identifier: "SchoolSurveyTextQuestion" });

/** Strict public List-question projection. */
export const SchoolSurveyListQuestion = Schema.Struct({
  kind: Schema.Literal("List"),
  ...QuestionBase,
  alternatives: Alternatives,
}).annotate({ identifier: "SchoolSurveyListQuestion" });

/** Strict public Radio-question projection. */
export const SchoolSurveyRadioQuestion = Schema.Struct({
  kind: Schema.Literal("Radio"),
  ...QuestionBase,
  alternatives: Alternatives,
}).annotate({ identifier: "SchoolSurveyRadioQuestion" });

/** Strict public Check-question projection. */
export const SchoolSurveyCheckQuestion = Schema.Struct({
  kind: Schema.Literal("Check"),
  ...QuestionBase,
  alternatives: Alternatives,
}).annotate({ identifier: "SchoolSurveyCheckQuestion" });

/** Ordered discriminated public question union. */
export const SchoolSurveyQuestion = Schema.Union([
  SchoolSurveyTextQuestion,
  SchoolSurveyListQuestion,
  SchoolSurveyRadioQuestion,
  SchoolSurveyCheckQuestion,
]).annotate({ identifier: "SchoolSurveyQuestion" });

export type SchoolSurveyQuestion = typeof SchoolSurveyQuestion.Type;

export const EligibleSurveySchool = Schema.Struct({
  schoolId: SchoolId,
  name: SchoolName,
}).annotate({ identifier: "EligibleSurveySchool" });

export type EligibleSurveySchool = typeof EligibleSurveySchool.Type;

/** Public anonymous form projection; it deliberately has no completion or respondent data. */
export const SchoolSurveyFormResource = Schema.Struct({
  surveyId: SurveyId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  semesterLabel: SemesterLabel,
  title: SurveyTitle,
  schools: Schema.Array(EligibleSurveySchool),
  questions: boundedArray(SchoolSurveyQuestion, 100, "at most 100 questions"),
}).annotate({ identifier: "SchoolSurveyFormResource" });

export type SchoolSurveyFormResource = typeof SchoolSurveyFormResource.Type;

/** Strict anonymous scalar Text-answer wire shape. */
export const SchoolSurveyTextAnswerInput = Schema.Struct({
  kind: Schema.Literal("Text"),
  questionId: SurveyQuestionId,
  value: AnswerText,
}).annotate({ identifier: "SchoolSurveyTextAnswerInput" });

/** Strict anonymous scalar List-answer wire shape. */
export const SchoolSurveyListAnswerInput = Schema.Struct({
  kind: Schema.Literal("List"),
  questionId: SurveyQuestionId,
  value: AnswerAlternative,
}).annotate({ identifier: "SchoolSurveyListAnswerInput" });

/** Strict anonymous scalar Radio-answer wire shape. */
export const SchoolSurveyRadioAnswerInput = Schema.Struct({
  kind: Schema.Literal("Radio"),
  questionId: SurveyQuestionId,
  value: AnswerAlternative,
}).annotate({ identifier: "SchoolSurveyRadioAnswerInput" });

/** Strict anonymous ordered Check-answer wire shape. */
export const SchoolSurveyCheckAnswerInput = Schema.Struct({
  kind: Schema.Literal("Check"),
  questionId: SurveyQuestionId,
  values: boundedArray(AnswerAlternative, 100, "at most 100 selected check values"),
}).annotate({ identifier: "SchoolSurveyCheckAnswerInput" });

/** Strict answer discriminated union; wrong fields and unknown kinds are rejected. */
export const SchoolSurveyAnswerInput = Schema.Union([
  SchoolSurveyTextAnswerInput,
  SchoolSurveyListAnswerInput,
  SchoolSurveyRadioAnswerInput,
  SchoolSurveyCheckAnswerInput,
]).annotate({ identifier: "SchoolSurveyAnswerInput" });

export type SchoolSurveyAnswerInput = typeof SchoolSurveyAnswerInput.Type;

/** Strict anonymous response submission body. */
export const SubmitSchoolSurveyResponseRequest = Schema.Struct({
  schoolId: SchoolId,
  answers: boundedArray(SchoolSurveyAnswerInput, 100, "at most 100 answers"),
}).annotate({ identifier: "SubmitSchoolSurveyResponseRequest" });

export type SubmitSchoolSurveyResponseRequest = typeof SubmitSchoolSurveyResponseRequest.Type;

/** First-accepted anonymous response representation and browser completion text. */
export const SchoolSurveyResponseResource = Schema.Struct({
  responseId: SurveyResponseId,
  submittedAt: Rfc3339InstantSchema,
  completionText: CompletionText,
}).annotate({ identifier: "SchoolSurveyResponseResource" });

export type SchoolSurveyResponseResource = typeof SchoolSurveyResponseResource.Type;

/** Transactionally normalized answer retained between pre-receipt validation and insert. */
export type NormalizedSchoolSurveyAnswer =
  | {
      readonly kind: "Text" | "List" | "Radio";
      readonly questionId: SurveyQuestionId;
      readonly value: string;
    }
  | {
      readonly kind: "Check";
      readonly questionId: SurveyQuestionId;
      readonly values: ReadonlyArray<string>;
    };

/** Validated current survey state retained in one serializable HTTP transaction. */
export interface PreparedSchoolSurveyResponse {
  readonly surveyId: SurveyId;
  readonly departmentId: DepartmentId;
  readonly completionText: string;
  readonly schoolId: SchoolId;
  readonly answers: ReadonlyArray<NormalizedSchoolSurveyAnswer>;
}

export const SurveyState = Schema.Literals(["Open", "Closed"]).annotate({
  identifier: "SurveyState",
});

export type SurveyState = typeof SurveyState.Type;

export const SurveyResultsVisibility = Schema.Literals([
  "DepartmentManagers",
  "GlobalAdministrators",
]).annotate({ identifier: "SurveyResultsVisibility" });

export type SurveyResultsVisibility = typeof SurveyResultsVisibility.Type;

const SurveyRevision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const SurveyResponseCount = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const RequiredAlternatives = Alternatives.pipe(
  Schema.check(
    Schema.makeFilter(
      (alternatives) =>
        alternatives.length > 0 &&
        new Set(alternatives).size === alternatives.length &&
        alternatives.every((alternative) => alternative.trim() === alternative),
      { message: "unique, whitespace-trimmed alternatives" },
    ),
  ),
);

const SchoolSurveyQuestionDraftBase = {
  label: QuestionLabel,
  help: Schema.NullOr(HelpText),
  required: Schema.Boolean,
} as const;

/** Server-identified Text question supplied when creating a School survey. */
export const SchoolSurveyTextQuestionDraft = Schema.Struct({
  kind: Schema.Literal("Text"),
  ...SchoolSurveyQuestionDraftBase,
}).annotate({ identifier: "SchoolSurveyTextQuestionDraft" });

export type SchoolSurveyTextQuestionDraft = typeof SchoolSurveyTextQuestionDraft.Type;

/** Server-identified List question supplied when creating a School survey. */
export const SchoolSurveyListQuestionDraft = Schema.Struct({
  kind: Schema.Literal("List"),
  ...SchoolSurveyQuestionDraftBase,
  alternatives: RequiredAlternatives,
}).annotate({ identifier: "SchoolSurveyListQuestionDraft" });

export type SchoolSurveyListQuestionDraft = typeof SchoolSurveyListQuestionDraft.Type;

/** Server-identified Radio question supplied when creating a School survey. */
export const SchoolSurveyRadioQuestionDraft = Schema.Struct({
  kind: Schema.Literal("Radio"),
  ...SchoolSurveyQuestionDraftBase,
  alternatives: RequiredAlternatives,
}).annotate({ identifier: "SchoolSurveyRadioQuestionDraft" });

export type SchoolSurveyRadioQuestionDraft = typeof SchoolSurveyRadioQuestionDraft.Type;

/** Server-identified Check question supplied when creating a School survey. */
export const SchoolSurveyCheckQuestionDraft = Schema.Struct({
  kind: Schema.Literal("Check"),
  ...SchoolSurveyQuestionDraftBase,
  alternatives: RequiredAlternatives,
}).annotate({ identifier: "SchoolSurveyCheckQuestionDraft" });

export type SchoolSurveyCheckQuestionDraft = typeof SchoolSurveyCheckQuestionDraft.Type;

export const SchoolSurveyQuestionDraft = Schema.Union([
  SchoolSurveyTextQuestionDraft,
  SchoolSurveyListQuestionDraft,
  SchoolSurveyRadioQuestionDraft,
  SchoolSurveyCheckQuestionDraft,
]).annotate({ identifier: "SchoolSurveyQuestionDraft" });

export type SchoolSurveyQuestionDraft = typeof SchoolSurveyQuestionDraft.Type;

const SchoolSurveyQuestionDrafts = boundedArray(
  SchoolSurveyQuestionDraft,
  100,
  "at most 100 questions",
).pipe(
  Schema.check(
    Schema.makeFilter((questions) => questions.length > 0, {
      message: "at least one question",
    }),
  ),
);

/** Strict external create body; the server supplies every durable identity. */
export const CreateSchoolSurveyRequest = Schema.Struct({
  departmentId: DepartmentId,
  semesterId: SemesterId,
  title: SurveyTitle,
  completionText: CreateCompletionText,
  resultsVisibility: SurveyResultsVisibility,
  questions: SchoolSurveyQuestionDrafts,
}).annotate({ identifier: "CreateSchoolSurveyRequest" });

export type CreateSchoolSurveyRequest = typeof CreateSchoolSurveyRequest.Type;

/** Strict external close body; closure is an Open-to-Closed revision transition. */
export const CloseSchoolSurveyRequest = Schema.Struct({
  expectedRevision: SurveyRevision,
}).annotate({ identifier: "CloseSchoolSurveyRequest" });

export type CloseSchoolSurveyRequest = typeof CloseSchoolSurveyRequest.Type;

export const SchoolSurveyAdminScope = Schema.Struct({
  departmentId: DepartmentId,
  semesterId: SemesterId,
}).annotate({ identifier: "SchoolSurveyAdminScope" });

export type SchoolSurveyAdminScope = typeof SchoolSurveyAdminScope.Type;

const lifecycleMetadataIsValid = Schema.makeFilter(
  (survey: {
    readonly state: SurveyState;
    readonly revision: number;
    readonly createdAt: string | null;
    readonly createdByPersonId: PersonId | null;
    readonly closedAt: string | null;
    readonly closedByPersonId: PersonId | null;
  }) => {
    const hasCreation = survey.createdAt !== null || survey.createdByPersonId !== null;

    if (hasCreation && (survey.createdAt === null || survey.createdByPersonId === null)) {
      return false;
    }

    if (survey.state === "Open") {
      return survey.closedAt === null && survey.closedByPersonId === null;
    }

    return survey.revision > 0 && survey.closedAt !== null && survey.closedByPersonId !== null;
  },
  { message: "consistent School-survey lifecycle metadata" },
);

/** Administrative definition, lifecycle, and policy-redacted response-count projection. */
export const SchoolSurveyAdminResource = Schema.Struct({
  surveyId: SurveyId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  semesterLabel: SemesterLabel,
  title: SurveyTitle,
  completionText: CompletionText,
  resultsVisibility: SurveyResultsVisibility,
  state: SurveyState,
  revision: SurveyRevision,
  createdAt: Schema.NullOr(Rfc3339InstantSchema),
  createdByPersonId: Schema.NullOr(PersonId),
  closedAt: Schema.NullOr(Rfc3339InstantSchema),
  closedByPersonId: Schema.NullOr(PersonId),
  responseCount: Schema.NullOr(SurveyResponseCount),
  questions: boundedArray(SchoolSurveyQuestion, 100, "at most 100 questions"),
})
  .pipe(Schema.check(lifecycleMetadataIsValid))
  .annotate({ identifier: "SchoolSurveyAdminResource" });

export type SchoolSurveyAdminResource = typeof SchoolSurveyAdminResource.Type;

export const SchoolSurveyAdminDepartmentResource = Schema.Struct({
  departmentId: DepartmentId,
  name: Schema.String,
}).annotate({ identifier: "SchoolSurveyAdminDepartmentResource" });

export type SchoolSurveyAdminDepartmentResource = typeof SchoolSurveyAdminDepartmentResource.Type;

export const SchoolSurveyAdminSemesterResource = Schema.Struct({
  semesterId: SemesterId,
  startAt: Rfc3339InstantSchema,
  endAt: Rfc3339InstantSchema,
}).annotate({ identifier: "SchoolSurveyAdminSemesterResource" });

export type SchoolSurveyAdminSemesterResource = typeof SchoolSurveyAdminSemesterResource.Type;

/** Management scope choices available to the currently authorized person. */
export const SchoolSurveyAdminCatalogResource = Schema.Struct({
  departments: Schema.Array(SchoolSurveyAdminDepartmentResource),
  semesters: Schema.Array(SchoolSurveyAdminSemesterResource),
}).annotate({ identifier: "SchoolSurveyAdminCatalogResource" });

export type SchoolSurveyAdminCatalogResource = typeof SchoolSurveyAdminCatalogResource.Type;

/** Ordered School-survey definitions with policy-redacted response counts for one owner scope. */
export const SchoolSurveyAdminListResource = Schema.Struct({
  ...SchoolSurveyAdminScope.fields,
  surveys: Schema.Array(SchoolSurveyAdminResource),
}).annotate({ identifier: "SchoolSurveyAdminListResource" });

export type SchoolSurveyAdminListResource = typeof SchoolSurveyAdminListResource.Type;

export const SchoolSurveyResultTextAnswer = Schema.Struct({
  kind: Schema.Literal("Text"),
  questionId: SurveyQuestionId,
  value: Schema.NullOr(AnswerText),
}).annotate({ identifier: "SchoolSurveyResultTextAnswer" });

export type SchoolSurveyResultTextAnswer = typeof SchoolSurveyResultTextAnswer.Type;

export const SchoolSurveyResultListAnswer = Schema.Struct({
  kind: Schema.Literal("List"),
  questionId: SurveyQuestionId,
  value: Schema.NullOr(AnswerAlternative),
}).annotate({ identifier: "SchoolSurveyResultListAnswer" });

export type SchoolSurveyResultListAnswer = typeof SchoolSurveyResultListAnswer.Type;

export const SchoolSurveyResultRadioAnswer = Schema.Struct({
  kind: Schema.Literal("Radio"),
  questionId: SurveyQuestionId,
  value: Schema.NullOr(AnswerAlternative),
}).annotate({ identifier: "SchoolSurveyResultRadioAnswer" });

export type SchoolSurveyResultRadioAnswer = typeof SchoolSurveyResultRadioAnswer.Type;

export const SchoolSurveyResultCheckAnswer = Schema.Struct({
  kind: Schema.Literal("Check"),
  questionId: SurveyQuestionId,
  values: Alternatives,
}).annotate({ identifier: "SchoolSurveyResultCheckAnswer" });

export type SchoolSurveyResultCheckAnswer = typeof SchoolSurveyResultCheckAnswer.Type;

export const SchoolSurveyResultAnswer = Schema.Union([
  SchoolSurveyResultTextAnswer,
  SchoolSurveyResultListAnswer,
  SchoolSurveyResultRadioAnswer,
  SchoolSurveyResultCheckAnswer,
]).annotate({ identifier: "SchoolSurveyResultAnswer" });

export type SchoolSurveyResultAnswer = typeof SchoolSurveyResultAnswer.Type;

/** One anonymous response row, with answers ordered to its survey definition. */
export const SchoolSurveyResultResponse = Schema.Struct({
  school: EligibleSurveySchool,
  submittedAt: Rfc3339InstantSchema,
  answers: boundedArray(SchoolSurveyResultAnswer, 100, "at most 100 answers"),
}).annotate({ identifier: "SchoolSurveyResultResponse" });

export type SchoolSurveyResultResponse = typeof SchoolSurveyResultResponse.Type;

/** Authorized result projection; it contains no respondent identity. */
export const SchoolSurveyResultsResource = Schema.Struct({
  survey: SchoolSurveyAdminResource,
  responseCount: SurveyResponseCount,
  responses: Schema.Array(SchoolSurveyResultResponse),
}).annotate({ identifier: "SchoolSurveyResultsResource" });

export type SchoolSurveyResultsResource = typeof SchoolSurveyResultsResource.Type;

/** Native HTTP-derived command identity retained by School-survey provenance. */
export const SchoolSurveyCommandId = boundedIdentifier(
  SURVEY_IDENTIFIER_MAX_UTF8_BYTES,
  "a School-survey command ID at most 128 UTF-8 bytes",
).pipe(Schema.brand("SchoolSurveyCommandId"));

export type SchoolSurveyCommandId = typeof SchoolSurveyCommandId.Type;

/** Caller-owned transaction input for one first-accepted School-survey create command. */
export const CreateSchoolSurveyCommand = Schema.Struct({
  commandId: SchoolSurveyCommandId,
  surveyId: SurveyId,
  actorPersonId: PersonId,
  occurredAt: Rfc3339InstantSchema,
  request: CreateSchoolSurveyRequest,
}).annotate({ identifier: "CreateSchoolSurveyCommand" });

export type CreateSchoolSurveyCommand = typeof CreateSchoolSurveyCommand.Type;

/** Caller-owned transaction input for one School-survey close command. */
export const CloseSchoolSurveyCommand = Schema.Struct({
  commandId: SchoolSurveyCommandId,
  surveyId: SurveyId,
  actorPersonId: PersonId,
  occurredAt: Rfc3339InstantSchema,
  request: CloseSchoolSurveyRequest,
}).annotate({ identifier: "CloseSchoolSurveyCommand" });

export type CloseSchoolSurveyCommand = typeof CloseSchoolSurveyCommand.Type;
