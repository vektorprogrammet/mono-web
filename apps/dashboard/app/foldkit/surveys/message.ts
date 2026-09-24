import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
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
import { SchoolSurveysFailure, SchoolSurveysRequestId } from "./model";

export const LoadedCatalog = taggedStruct("LoadedCatalog", {
  requestId: SchoolSurveysRequestId,
  catalog: SchoolSurveyAdminCatalogResource,
});

export const FailedCatalog = taggedStruct("FailedCatalog", {
  requestId: SchoolSurveysRequestId,
  failure: SchoolSurveysFailure,
});

export const RetriedCatalog = taggedStruct("RetriedCatalog", {});

export const SelectedDepartment = taggedStruct("SelectedDepartment", {
  departmentId: S.NullOr(CreateSchoolSurveyRequest.fields.departmentId),
});

export const SelectedSemester = taggedStruct("SelectedSemester", {
  semesterId: S.NullOr(CreateSchoolSurveyRequest.fields.semesterId),
});

export const ChangedTitle = taggedStruct("ChangedTitle", { value: S.String });

export const ChangedCompletionText = taggedStruct("ChangedCompletionText", { value: S.String });

export const SelectedResultsVisibility = taggedStruct("SelectedResultsVisibility", {
  resultsVisibility: SurveyResultsVisibility,
});

export const AddedQuestion = taggedStruct("AddedQuestion", { kind: SchoolSurveyQuestionKind });

export const RemovedQuestion = taggedStruct("RemovedQuestion", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
});

export const ChangedQuestionKind = taggedStruct("ChangedQuestionKind", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  kind: SchoolSurveyQuestionKind,
});

export const ChangedQuestionLabel = taggedStruct("ChangedQuestionLabel", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  value: S.String,
});

export const ChangedQuestionHelp = taggedStruct("ChangedQuestionHelp", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  value: S.String,
});

export const ChangedQuestionRequired = taggedStruct("ChangedQuestionRequired", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  required: S.Boolean,
});

export const AddedAlternative = taggedStruct("AddedAlternative", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
});

export const ChangedAlternative = taggedStruct("ChangedAlternative", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  index: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  value: S.String,
});

export const RemovedAlternative = taggedStruct("RemovedAlternative", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  index: S.Int.check(S.isGreaterThanOrEqualTo(0)),
});

export const LoadedList = taggedStruct("LoadedList", {
  requestId: SchoolSurveysRequestId,
  list: SchoolSurveyAdminListResource,
});

export const FailedList = taggedStruct("FailedList", {
  requestId: SchoolSurveysRequestId,
  failure: SchoolSurveysFailure,
});

export const RetriedList = taggedStruct("RetriedList", {});

export const SelectedSurvey = taggedStruct("SelectedSurvey", { surveyId: SurveyId });

export const RequestedResults = taggedStruct("RequestedResults", { surveyId: SurveyId });

export const LoadedResults = taggedStruct("LoadedResults", {
  requestId: SchoolSurveysRequestId,
  surveyId: SurveyId,
  results: SchoolSurveyResultsResource,
});

export const FailedResults = taggedStruct("FailedResults", {
  requestId: SchoolSurveysRequestId,
  surveyId: SurveyId,
  failure: SchoolSurveysFailure,
});

export const RetriedResults = taggedStruct("RetriedResults", {});

export const SubmittedCreate = taggedStruct("SubmittedCreate", {});

export const SucceededCreate = taggedStruct("SucceededCreate", {
  requestId: SchoolSurveysRequestId,
  survey: SchoolSurveyAdminResource,
});

export const FailedCreate = taggedStruct("FailedCreate", {
  requestId: SchoolSurveysRequestId,
  commandId: IdempotencyKey,
  failure: SchoolSurveysFailure,
});

export const SubmittedClose = taggedStruct("SubmittedClose", {
  surveyId: SurveyId,
  expectedRevision: CloseSchoolSurveyRequest.fields.expectedRevision,
});

export const SucceededClose = taggedStruct("SucceededClose", {
  requestId: SchoolSurveysRequestId,
  survey: SchoolSurveyAdminResource,
});

export const FailedClose = taggedStruct("FailedClose", {
  requestId: SchoolSurveysRequestId,
  commandId: IdempotencyKey,
  surveyId: SurveyId,
  expectedRevision: CloseSchoolSurveyRequest.fields.expectedRevision,
  failure: SchoolSurveysFailure,
});

export const DismissedBanner = taggedStruct("DismissedBanner", {});

export const Message = S.Union([
  LoadedCatalog,
  FailedCatalog,
  RetriedCatalog,
  SelectedDepartment,
  SelectedSemester,
  ChangedTitle,
  ChangedCompletionText,
  SelectedResultsVisibility,
  AddedQuestion,
  RemovedQuestion,
  ChangedQuestionKind,
  ChangedQuestionLabel,
  ChangedQuestionHelp,
  ChangedQuestionRequired,
  AddedAlternative,
  ChangedAlternative,
  RemovedAlternative,
  LoadedList,
  FailedList,
  RetriedList,
  SelectedSurvey,
  RequestedResults,
  LoadedResults,
  FailedResults,
  RetriedResults,
  SubmittedCreate,
  SucceededCreate,
  FailedCreate,
  SubmittedClose,
  SucceededClose,
  FailedClose,
  DismissedBanner,
]);

export type Message = S.Schema.Type<typeof Message>;
