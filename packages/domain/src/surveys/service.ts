import { Context, Effect } from "effect";
import type { SchoolSurveyFailure } from "./errors.js";
import type {
  PreparedSchoolSurveyResponse,
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SubmitSchoolSurveyResponseRequest,
  SurveyId,
  SurveyResponseId,
} from "./schema.js";

/** Portable anonymous school-survey capability; callers retain transaction ownership. */
export interface SchoolSurveysShape {
  readonly readForm: (
    surveyId: SurveyId,
  ) => Effect.Effect<SchoolSurveyFormResource, SchoolSurveyFailure>;
  /** Resolves the current School survey, eligibility, and canonical answer order before receipt lookup. */
  readonly prepareResponse: (input: {
    readonly surveyId: SurveyId;
    readonly request: SubmitSchoolSurveyResponseRequest;
  }) => Effect.Effect<PreparedSchoolSurveyResponse, SchoolSurveyFailure>;
  /** Persists a response already prepared in the surrounding serializable transaction. */
  readonly persistResponse: (input: {
    readonly responseId: SurveyResponseId;
    readonly prepared: PreparedSchoolSurveyResponse;
  }) => Effect.Effect<SchoolSurveyResponseResource, SchoolSurveyFailure>;
}

export class SchoolSurveys extends Context.Service<SchoolSurveys, SchoolSurveysShape>()(
  "@vektorprogrammet/domain/SchoolSurveys",
) {}
