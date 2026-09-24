import { Context, Effect } from "effect";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import type { SchoolSurveyFailure } from "./errors.js";
import type {
  CloseSchoolSurveyCommand,
  CreateSchoolSurveyCommand,
  PreparedSchoolSurveyResponse,
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyAdminScope,
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SchoolSurveyResultsResource,
  SubmitSchoolSurveyResponseRequest,
  SurveyId,
  SurveyResponseId,
} from "./schema.js";

/** Portable anonymous school-survey capability; callers retain transaction ownership. */
export interface SchoolSurveysOperations {
  readonly readForm: (
    surveyId: SurveyId,
  ) => Effect.Effect<SchoolSurveyFormResource, SchoolSurveyFailure>;
  /** Resolves the current School survey, eligibility, and canonical answer order before a new write. */
  readonly prepareResponse: (input: {
    readonly surveyId: SurveyId;
    readonly request: SubmitSchoolSurveyResponseRequest;
  }) => Effect.Effect<PreparedSchoolSurveyResponse, SchoolSurveyFailure>;
  /** Persists a response already prepared in the surrounding serializable transaction. */
  readonly persistResponse: (input: {
    readonly responseId: SurveyResponseId;
    readonly prepared: PreparedSchoolSurveyResponse;
  }) => Effect.Effect<SchoolSurveyResponseResource, SchoolSurveyFailure>;
  /** Returns only scopes the supplied current organization authority can manage. */
  readonly readAdminCatalog: (
    authority: OrganizationPersonAuthority,
  ) => Effect.Effect<SchoolSurveyAdminCatalogResource, SchoolSurveyFailure>;
  /** Reads one School survey's full immutable definition and current lifecycle metadata. */
  readonly readAdminSurvey: (
    surveyId: SurveyId,
  ) => Effect.Effect<SchoolSurveyAdminResource, SchoolSurveyFailure>;
  /** Lists one validated owner scope in a stable definition order. */
  readonly listAdminSurveys: (
    scope: SchoolSurveyAdminScope,
  ) => Effect.Effect<SchoolSurveyAdminListResource, SchoolSurveyFailure>;
  /** Persists one server-identified, initially Open School survey and its audit row. */
  readonly createAdminSurvey: (
    command: CreateSchoolSurveyCommand,
  ) => Effect.Effect<SchoolSurveyAdminResource, SchoolSurveyFailure>;
  /** Performs the only allowed lifecycle transition, Open to Closed. */
  readonly closeAdminSurvey: (
    command: CloseSchoolSurveyCommand,
  ) => Effect.Effect<SchoolSurveyAdminResource, SchoolSurveyFailure>;
  /** Reads ordered anonymous responses from an already authorized result projection. */
  readonly readAdminResults: (
    surveyId: SurveyId,
  ) => Effect.Effect<SchoolSurveyResultsResource, SchoolSurveyFailure>;
}

export class SchoolSurveys extends Context.Service<SchoolSurveys, SchoolSurveysOperations>()(
  "@vektorprogrammet/domain/SchoolSurveys",
) {}
