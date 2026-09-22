import {
  CloseSchoolSurveyRequest,
  CreateSchoolSurveyRequest,
  IdempotencyKey,
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyQuestionKind,
  SchoolSurveyResultsResource,
  SurveyId,
  SurveyResultsVisibility,
} from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";

export {
  CloseSchoolSurveyRequest,
  CreateSchoolSurveyRequest,
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyQuestionKind,
  SchoolSurveyResultsResource,
  SurveyId,
  SurveyResultsVisibility,
};

export const SchoolSurveysBridgeErrorTag = S.Literals([
  "UnauthenticatedActor",
  "NotInScope",
  "SurveyNotFound",
  "ValidationFailed",
  "CommandConflict",
  "SurveyDecodeError",
  "SurveyPersistenceError",
  "Network",
  "Configuration",
]);
export type SchoolSurveysBridgeErrorTag = S.Schema.Type<typeof SchoolSurveysBridgeErrorTag>;

export const SchoolSurveysBridgeFailure = S.Struct({
  error: S.Struct({ tag: SchoolSurveysBridgeErrorTag }),
});
export type SchoolSurveysBridgeFailure = S.Schema.Type<typeof SchoolSurveysBridgeFailure>;

export const schoolSurveysBridgeFailure = (
  tag: SchoolSurveysBridgeErrorTag,
): SchoolSurveysBridgeFailure => ({ error: { tag } });

export const SchoolSurveyListInput = S.Struct({
  departmentId: CreateSchoolSurveyRequest.fields.departmentId,
  semesterId: CreateSchoolSurveyRequest.fields.semesterId,
});
export type SchoolSurveyListInput = S.Schema.Type<typeof SchoolSurveyListInput>;

export const SchoolSurveyCreateCommand = S.Struct({
  commandId: IdempotencyKey,
  ...CreateSchoolSurveyRequest.fields,
});
export type SchoolSurveyCreateCommand = S.Schema.Type<typeof SchoolSurveyCreateCommand>;

export const SchoolSurveyCloseCommand = S.Struct({
  commandId: IdempotencyKey,
  surveyId: SurveyId,
  ...CloseSchoolSurveyRequest.fields,
});
export type SchoolSurveyCloseCommand = S.Schema.Type<typeof SchoolSurveyCloseCommand>;

const ListOperation = S.Struct({ operation: S.Literal("list"), query: SchoolSurveyListInput });
const CreateOperation = S.Struct({
  operation: S.Literal("create"),
  ...SchoolSurveyCreateCommand.fields,
});
const CloseOperation = S.Struct({
  operation: S.Literal("close"),
  ...SchoolSurveyCloseCommand.fields,
});
const ResultsOperation = S.Struct({ operation: S.Literal("results"), surveyId: SurveyId });

export const SchoolSurveysBridgeOperation = S.Union([
  ListOperation,
  CreateOperation,
  CloseOperation,
  ResultsOperation,
]);
export type SchoolSurveysBridgeOperation = S.Schema.Type<typeof SchoolSurveysBridgeOperation>;
export const SchoolSurveysBridgeOperationJson = S.fromJsonString(SchoolSurveysBridgeOperation);
