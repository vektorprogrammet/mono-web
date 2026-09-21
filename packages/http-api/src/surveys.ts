import {
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SubmitSchoolSurveyResponseRequest,
  SurveyId,
} from "@vektorprogrammet/domain";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, anonymousNativeAccess } from "./access.js";
import { operationAnnotations } from "./common.js";
import {
  createdMutationResponse,
  endpointProblemResponses,
  IdempotencyHeaders,
  noStoreReadResponse,
  problemUnion,
} from "./http-semantics.js";

export {
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SubmitSchoolSurveyResponseRequest,
  SurveyId,
};

export const SchoolSurveyReadProblem = problemUnion("SchoolSurveyReadProblem", [
  ["request.malformed", 400],
  ["resource.not-found", 404],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
]);

export const SchoolSurveySubmitProblem = problemUnion("SchoolSurveySubmitProblem", [
  ["request.malformed", 400],
  ["idempotency-key.invalid", 400],
  ["resource.not-found", 404],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["idempotency.unavailable", 503],
]);

/** @since 0.2.0 @category Endpoints */
export const ReadSchoolSurveyEndpoint = HttpApiEndpoint.get(
  "readSchoolSurvey",
  "/api/surveys/:surveyId",
  {
    params: { surveyId: SurveyId },
    success: noStoreReadResponse(SchoolSurveyFormResource),
    error: endpointProblemResponses(SchoolSurveyReadProblem),
  },
)
  .pipe((endpoint) => annotateAccessSpec(endpoint, anonymousNativeAccess("surveys.form")))
  .annotateMerge(
    operationAnnotations("Read school survey", "Returns one anonymous school-survey form."),
  );

/** @since 0.2.0 @category Endpoints */
export const SubmitSchoolSurveyResponseEndpoint = HttpApiEndpoint.post(
  "submitSchoolSurveyResponse",
  "/api/surveys/:surveyId/responses",
  {
    params: { surveyId: SurveyId },
    headers: IdempotencyHeaders,
    payload: SubmitSchoolSurveyResponseRequest,
    success: createdMutationResponse(SchoolSurveyResponseResource.pipe(HttpApiSchema.status(201))),
    error: endpointProblemResponses(SchoolSurveySubmitProblem),
  },
)
  .pipe((endpoint) =>
    annotateAccessSpec(endpoint, anonymousNativeAccess("surveys.response-create", "Transaction")),
  )
  .annotateMerge(
    operationAnnotations(
      "Submit school survey response",
      "Creates or replays one anonymous school-survey response command.",
    ),
  );

export class SchoolSurveysApi extends HttpApiGroup.make("surveys")
  .add(ReadSchoolSurveyEndpoint)
  .add(SubmitSchoolSurveyResponseEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "School surveys",
      description: "Anonymous participation in imported school surveys.",
    }),
  ) {}
