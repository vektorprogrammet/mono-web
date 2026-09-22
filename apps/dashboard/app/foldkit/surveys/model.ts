import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import {
  CloseSchoolSurveyRequest,
  CreateSchoolSurveyRequest,
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyQuestionKind,
  SchoolSurveyResultsResource,
  SurveyId,
  SurveyResultsVisibility,
} from "./bridge";

export const SchoolSurveysRequestId = S.Int.check(S.isGreaterThanOrEqualTo(1));
export type SchoolSurveysRequestId = S.Schema.Type<typeof SchoolSurveysRequestId>;

export const SchoolSurveysFailureTag = S.Literals([
  "UnauthenticatedActor",
  "NotInScope",
  "SurveyNotFound",
  "ValidationFailed",
  "CommandConflict",
  "SurveyDecodeError",
  "SurveyPersistenceError",
  "Network",
  "Configuration",
  "InvalidDraft",
]);
export type SchoolSurveysFailureTag = S.Schema.Type<typeof SchoolSurveysFailureTag>;

export const SchoolSurveysFailure = S.TaggedUnion({
  Denied: {
    tag: S.Literals(["UnauthenticatedActor", "NotInScope"]),
    message: S.String,
  },
  Failed: {
    tag: S.Literals([
      "SurveyNotFound",
      "ValidationFailed",
      "CommandConflict",
      "SurveyDecodeError",
      "SurveyPersistenceError",
      "Network",
      "Configuration",
      "InvalidDraft",
    ]),
    message: S.String,
  },
});
export type SchoolSurveysFailure = S.Schema.Type<typeof SchoolSurveysFailure>;

export const QuestionDraft = S.Struct({
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  kind: SchoolSurveyQuestionKind,
  label: S.String,
  help: S.String,
  required: S.Boolean,
  alternatives: S.Array(S.String),
});
export type QuestionDraft = S.Schema.Type<typeof QuestionDraft>;

export const SurveyDraft = S.Struct({
  departmentId: S.NullOr(CreateSchoolSurveyRequest.fields.departmentId),
  semesterId: S.NullOr(CreateSchoolSurveyRequest.fields.semesterId),
  title: S.String,
  completionText: S.String,
  resultsVisibility: SurveyResultsVisibility,
  questions: S.Array(QuestionDraft),
});
export type SurveyDraft = S.Schema.Type<typeof SurveyDraft>;

export const CatalogState = S.TaggedUnion({
  Idle: {},
  Loading: { requestId: SchoolSurveysRequestId },
  Success: { data: SchoolSurveyAdminCatalogResource },
  Failure: { error: SchoolSurveysFailure },
});
export type CatalogState = S.Schema.Type<typeof CatalogState>;

export const ListState = S.TaggedUnion({
  Idle: {},
  Loading: { requestId: SchoolSurveysRequestId },
  Success: { data: SchoolSurveyAdminListResource },
  Failure: { error: SchoolSurveysFailure },
});
export type ListState = S.Schema.Type<typeof ListState>;

export const ResultsState = S.TaggedUnion({
  Idle: {},
  Loading: { requestId: SchoolSurveysRequestId, surveyId: SurveyId },
  Success: { data: SchoolSurveyResultsResource },
  Failure: { error: SchoolSurveysFailure, surveyId: SurveyId },
});
export type ResultsState = S.Schema.Type<typeof ResultsState>;

export const PendingCommand = S.Literals(["Create", "Close"]);
export type PendingCommand = S.Schema.Type<typeof PendingCommand>;

export const RetriableCreate = S.Struct({
  commandId: IdempotencyKey,
  draft: SurveyDraft,
});

export const RetriableClose = S.Struct({
  commandId: IdempotencyKey,
  surveyId: SurveyId,
  expectedRevision: CloseSchoolSurveyRequest.fields.expectedRevision,
});

export const Model = S.Struct({
  catalog: CatalogState,
  list: ListState,
  detail: S.NullOr(SchoolSurveyAdminResource),
  results: ResultsState,
  draft: SurveyDraft,
  selectedSurveyId: S.NullOr(SurveyId),
  requestSequence: SchoolSurveysRequestId,
  questionSequence: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  commandSequence: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  commandSeed: S.String,
  pendingCommand: S.NullOr(PendingCommand),
  retryCreate: S.NullOr(RetriableCreate),
  retryClose: S.NullOr(RetriableClose),
  banner: S.NullOr(SchoolSurveysFailure),
  successMessage: S.NullOr(S.String),
});
export type Model = S.Schema.Type<typeof Model>;

export const makeQuestionDraft = (draftId: number, kind: QuestionDraft["kind"]): QuestionDraft => ({
  draftId,
  kind,
  label: "",
  help: "",
  required: false,
  alternatives: kind === "Text" ? [] : ["", ""],
});

export const makeDraft = (): SurveyDraft => ({
  departmentId: null,
  semesterId: null,
  title: "",
  completionText: "",
  resultsVisibility: "DepartmentManagers",
  questions: [],
});

export const makeInitialModel = (): Model => ({
  catalog: { _tag: "Loading", requestId: 1 },
  list: { _tag: "Idle" },
  detail: null,
  results: { _tag: "Idle" },
  draft: makeDraft(),
  selectedSurveyId: null,
  requestSequence: 1,
  questionSequence: 1,
  commandSequence: 1,
  commandSeed: globalThis.crypto.randomUUID().replaceAll("-", ""),
  pendingCommand: null,
  retryCreate: null,
  retryClose: null,
  banner: null,
  successMessage: null,
});
