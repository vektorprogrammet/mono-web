import { Schema } from "effect";
import { DepartmentId, SemesterId } from "../organization/schema.js";
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

const boundedText = (maximumBytes: number, message: string) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => utf8ByteLength(value.trim()) <= maximumBytes, { message }),
    ),
  );
const boundedIdentifier = (maximumBytes: number, message: string) =>
  boundedText(maximumBytes, message).pipe(
    Schema.check(
      Schema.makeFilter((value) => value.length > 0 && value.trim() === value, {
        message: "a trimmed non-empty identifier",
      }),
    ),
  );
const boundedImportedText = (maximumBytes: number, message: string) =>
  boundedText(maximumBytes, message).pipe(
    Schema.check(
      Schema.makeFilter((value) => value.trim().length > 0 && value.trim() === value, {
        message: "a trimmed non-empty imported string",
      }),
    ),
  );
const boundedArray = <S extends Schema.Top>(schema: S, maximum: number, message: string) =>
  Schema.Array(schema).pipe(
    Schema.check(Schema.makeFilter((value) => value.length <= maximum, { message })),
  );

/** Opaque imported survey identity. */
export const SurveyId = boundedIdentifier(128, "a survey ID at most 128 UTF-8 bytes").pipe(
  Schema.brand("SurveyId"),
);
export type SurveyId = typeof SurveyId.Type;

/** Opaque imported survey-question identity. */
export const SurveyQuestionId = boundedIdentifier(
  128,
  "a survey question ID at most 128 UTF-8 bytes",
).pipe(Schema.brand("SurveyQuestionId"));
export type SurveyQuestionId = typeof SurveyQuestionId.Type;

/** Opaque server-issued anonymous response identity. */
export const SurveyResponseId = boundedIdentifier(
  128,
  "a survey response ID at most 128 UTF-8 bytes",
).pipe(Schema.brand("SurveyResponseId"));
export type SurveyResponseId = typeof SurveyResponseId.Type;

export const SchoolSurveyQuestionKind = Schema.Literals(["Text", "List", "Radio", "Check"]);
const AnswerAlternative = boundedText(500, "an alternative at most 500 UTF-8 bytes");
export type SchoolSurveyQuestionKind = typeof SchoolSurveyQuestionKind.Type;

const QuestionLabel = boundedImportedText(1_000, "a question label at most 1000 UTF-8 bytes");
const HelpText = boundedImportedText(1_000, "help text at most 1000 UTF-8 bytes");
const Alternative = boundedImportedText(500, "an alternative at most 500 UTF-8 bytes");
const SemesterLabel = boundedImportedText(100, "a semester label at most 100 UTF-8 bytes");
const SurveyTitle = boundedImportedText(255, "a title at most 255 UTF-8 bytes");
const CompletionText = boundedText(4_096, "completion text at most 4096 UTF-8 bytes");
const AnswerText = boundedText(4_096, "an answer at most 4096 UTF-8 bytes");
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
