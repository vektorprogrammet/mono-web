import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { m } from "foldkit/message";
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

export const LoadedCatalog = m("LoadedCatalog", {
  requestId: SchoolSurveysRequestId,
  catalog: SchoolSurveyAdminCatalogResource,
});
export const FailedCatalog = m("FailedCatalog", {
  requestId: SchoolSurveysRequestId,
  failure: SchoolSurveysFailure,
});
export const RetriedCatalog = m("RetriedCatalog");

export const SelectedDepartment = m("SelectedDepartment", {
  departmentId: S.NullOr(CreateSchoolSurveyRequest.fields.departmentId),
});
export const SelectedSemester = m("SelectedSemester", {
  semesterId: S.NullOr(CreateSchoolSurveyRequest.fields.semesterId),
});
export const ChangedTitle = m("ChangedTitle", { value: S.String });
export const ChangedCompletionText = m("ChangedCompletionText", { value: S.String });
export const SelectedResultsVisibility = m("SelectedResultsVisibility", {
  resultsVisibility: SurveyResultsVisibility,
});
export const AddedQuestion = m("AddedQuestion", { kind: SchoolSurveyQuestionKind });
export const RemovedQuestion = m("RemovedQuestion", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
});
export const ChangedQuestionKind = m("ChangedQuestionKind", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  kind: SchoolSurveyQuestionKind,
});
export const ChangedQuestionLabel = m("ChangedQuestionLabel", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  value: S.String,
});
export const ChangedQuestionHelp = m("ChangedQuestionHelp", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  value: S.String,
});
export const ChangedQuestionRequired = m("ChangedQuestionRequired", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  required: S.Boolean,
});
export const AddedAlternative = m("AddedAlternative", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
});
export const ChangedAlternative = m("ChangedAlternative", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  index: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  value: S.String,
});
export const RemovedAlternative = m("RemovedAlternative", {
  draftId: S.Int.check(S.isGreaterThanOrEqualTo(1)),
  index: S.Int.check(S.isGreaterThanOrEqualTo(0)),
});

export const LoadedList = m("LoadedList", {
  requestId: SchoolSurveysRequestId,
  list: SchoolSurveyAdminListResource,
});
export const FailedList = m("FailedList", {
  requestId: SchoolSurveysRequestId,
  failure: SchoolSurveysFailure,
});
export const RetriedList = m("RetriedList");

export const SelectedSurvey = m("SelectedSurvey", { surveyId: SurveyId });

export const RequestedResults = m("RequestedResults", { surveyId: SurveyId });
export const LoadedResults = m("LoadedResults", {
  requestId: SchoolSurveysRequestId,
  surveyId: SurveyId,
  results: SchoolSurveyResultsResource,
});
export const FailedResults = m("FailedResults", {
  requestId: SchoolSurveysRequestId,
  surveyId: SurveyId,
  failure: SchoolSurveysFailure,
});
export const RetriedResults = m("RetriedResults");

export const SubmittedCreate = m("SubmittedCreate");
export const SucceededCreate = m("SucceededCreate", {
  requestId: SchoolSurveysRequestId,
  survey: SchoolSurveyAdminResource,
});
export const FailedCreate = m("FailedCreate", {
  requestId: SchoolSurveysRequestId,
  commandId: IdempotencyKey,
  failure: SchoolSurveysFailure,
});

export const SubmittedClose = m("SubmittedClose", {
  surveyId: SurveyId,
  expectedRevision: CloseSchoolSurveyRequest.fields.expectedRevision,
});
export const SucceededClose = m("SucceededClose", {
  requestId: SchoolSurveysRequestId,
  survey: SchoolSurveyAdminResource,
});
export const FailedClose = m("FailedClose", {
  requestId: SchoolSurveysRequestId,
  commandId: IdempotencyKey,
  surveyId: SurveyId,
  expectedRevision: CloseSchoolSurveyRequest.fields.expectedRevision,
  failure: SchoolSurveysFailure,
});

export const DismissedBanner = m("DismissedBanner");

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
