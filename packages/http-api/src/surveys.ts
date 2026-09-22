import {
  CloseSchoolSurveyRequest,
  CreateSchoolSurveyRequest,
  SchoolSurveyQuestionKind,
  DepartmentId,
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SchoolSurveyResultsResource,
  SurveyQuestionId,
  SurveyResultsVisibility,
  SurveyState,
  SemesterId,
  SubmitSchoolSurveyResponseRequest,
  SurveyId,
} from "@vektorprogrammet/domain";
import { makeAccessSpec } from "@vektorprogrammet/domain/authz";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { annotateAccessSpec, anonymousNativeAccess } from "./access.js";
import { operationAnnotations, PersonSecurity } from "./common.js";
import {
  createdMutationResponse,
  endpointProblemResponses,
  entityMutationResponse,
  IdempotencyHeaders,
  noStoreReadResponse,
  privateReadResponse,
  problemUnion,
} from "./http-semantics.js";

export {
  CloseSchoolSurveyRequest,
  CreateSchoolSurveyRequest,
  SchoolSurveyQuestionKind,
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyFormResource,
  SchoolSurveyResponseResource,
  SchoolSurveyResultsResource,
  SubmitSchoolSurveyResponseRequest,
  SurveyQuestionId,
  SurveyResultsVisibility,
  SurveyState,
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

const schoolSurveyAdminReadProblems = [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["resource.not-found", 404],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["organization.unavailable", 503],
] as const;

export const SchoolSurveyAdminCatalogProblem = problemUnion("SchoolSurveyAdminCatalogProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["organization.unavailable", 503],
]);

export const SchoolSurveyAdminListProblem = problemUnion("SchoolSurveyAdminListProblem", [
  ...schoolSurveyAdminReadProblems,
  ["scope.invalid", 422],
]);

export const SchoolSurveyAdminCreateProblem = problemUnion("SchoolSurveyAdminCreateProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["scope.invalid", 422],
  ["validation.failed", 422],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["organization.unavailable", 503],
  ["idempotency.unavailable", 503],
]);

export const SchoolSurveyAdminCloseProblem = problemUnion("SchoolSurveyAdminCloseProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["idempotency-key.invalid", 400],
  ["resource.not-found", 404],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["precondition.failed", 412],
  ["request.too-large", 413],
  ["media-type.unsupported", 415],
  ["validation.failed", 422],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["organization.unavailable", 503],
  ["idempotency.unavailable", 503],
]);

export const SchoolSurveyAdminResultsProblem = problemUnion("SchoolSurveyAdminResultsProblem", [
  ...schoolSurveyAdminReadProblems,
]);

export const schoolSurveyResultsCsvContentDisposition = (surveyId: SurveyId): string => {
  const encodedSurveyId = encodeURIComponent(String(surveyId)).replace(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
  return `attachment; filename="school-survey-${encodedSurveyId}-results.csv"`;
};

const SchoolSurveyResultsCsvContentDisposition = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        /^attachment; filename="school-survey-[A-Za-z0-9._~%-]+-results\.csv"$/u.test(value),
      { message: "a deterministic school-survey CSV attachment filename" },
    ),
  ),
);
const SchoolSurveyResultsCsvResponse = HttpApiSchema.WithHeaders(
  Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv; charset=utf-8" })),
  {
    "cache-control": Schema.Literal("private, no-store"),
    vary: Schema.Literal("Origin"),
    "content-disposition": SchoolSurveyResultsCsvContentDisposition,
    "content-type": Schema.Literal("text/csv; charset=utf-8"),
  },
);

const schoolSurveyAdminAccess = (
  canonicalScopeResolver:
    | "surveys.admin-catalog"
    | "surveys.admin-list"
    | "surveys.admin-create"
    | "surveys.admin-close"
    | "surveys.admin-results"
    | "surveys.admin-results-export",
  decisionTime: "SnapshotRead" | "Transaction",
  concealScope = false,
) =>
  makeAccessSpec({
    exposure: "External",
    acceptedCredentials: [{ _tag: "BetterAuthCookie" }, { _tag: "OAuthUserBearer" }],
    principalKinds: ["Person"],
    capabilities: { _tag: "None" },
    requirements: [],
    canonicalScopeResolver,
    concealment: concealScope ? { _tag: "NotFound", conceal: ["Scope"] } : { _tag: "Reveal" },
    decisionTime,
  });

/** @since 0.2.0 @category Endpoints */
export const ReadSchoolSurveyEndpoint = HttpApiEndpoint.get(
  "readSchoolSurvey",
  "/api/surveys/public/:surveyId",
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
  "/api/surveys/public/:surveyId/responses",
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

/** @since 0.2.0 @category Endpoints */
export const ReadAdminCatalogEndpoint = HttpApiEndpoint.get(
  "readAdminCatalog",
  "/api/surveys/admin/catalog",
  {
    success: privateReadResponse(SchoolSurveyAdminCatalogResource),
    error: endpointProblemResponses(SchoolSurveyAdminCatalogProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(endpoint, schoolSurveyAdminAccess("surveys.admin-catalog", "SnapshotRead")),
  )
  .annotateMerge(
    operationAnnotations(
      "Read school survey administration catalog",
      "Returns the authorized department and semester catalog for school-survey administration.",
    ),
  );

/** @since 0.2.0 @category Endpoints */
export const ListAdminSurveysEndpoint = HttpApiEndpoint.get(
  "listAdminSurveys",
  "/api/surveys/admin",
  {
    query: { departmentId: DepartmentId, semesterId: SemesterId },
    success: privateReadResponse(SchoolSurveyAdminListResource),
    error: endpointProblemResponses(SchoolSurveyAdminListProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(endpoint, schoolSurveyAdminAccess("surveys.admin-list", "SnapshotRead")),
  )
  .annotateMerge(
    operationAnnotations(
      "List administered school surveys",
      "Returns school surveys for one authorized department and semester.",
    ),
  );

/** @since 0.2.0 @category Endpoints */
export const CreateAdminSurveyEndpoint = HttpApiEndpoint.post(
  "createAdminSurvey",
  "/api/surveys/admin",
  {
    headers: IdempotencyHeaders,
    payload: CreateSchoolSurveyRequest,
    success: createdMutationResponse(SchoolSurveyAdminResource.pipe(HttpApiSchema.status(201))),
    error: endpointProblemResponses(SchoolSurveyAdminCreateProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(endpoint, schoolSurveyAdminAccess("surveys.admin-create", "Transaction")),
  )
  .annotateMerge(
    operationAnnotations("Create school survey", "Creates or replays one open School survey."),
  );

/** @since 0.2.0 @category Endpoints */
export const CloseAdminSurveyEndpoint = HttpApiEndpoint.post(
  "closeAdminSurvey",
  "/api/surveys/admin/:surveyId/close",
  {
    params: { surveyId: SurveyId },
    headers: IdempotencyHeaders,
    payload: CloseSchoolSurveyRequest,
    success: entityMutationResponse(SchoolSurveyAdminResource),
    error: endpointProblemResponses(SchoolSurveyAdminCloseProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      schoolSurveyAdminAccess("surveys.admin-close", "Transaction", true),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Close school survey",
      "Closes one School survey at its expected revision.",
    ),
  );

/** @since 0.2.0 @category Endpoints */
export const ReadAdminResultsEndpoint = HttpApiEndpoint.get(
  "readAdminResults",
  "/api/surveys/admin/:surveyId/results",
  {
    params: { surveyId: SurveyId },
    success: privateReadResponse(SchoolSurveyResultsResource),
    error: endpointProblemResponses(SchoolSurveyAdminResultsProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      schoolSurveyAdminAccess("surveys.admin-results", "SnapshotRead", true),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Read school survey results",
      "Returns the authorized anonymous response projection for one School survey.",
    ),
  );

/** @since 0.2.0 @category Endpoints */
export const ExportAdminResultsEndpoint = HttpApiEndpoint.get(
  "exportAdminResults",
  "/api/surveys/admin/:surveyId/results.csv",
  {
    params: { surveyId: SurveyId },
    success: SchoolSurveyResultsCsvResponse,
    error: endpointProblemResponses(SchoolSurveyAdminResultsProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      schoolSurveyAdminAccess("surveys.admin-results-export", "SnapshotRead", true),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Export school survey results",
      "Returns the authorized School-survey result projection as CSV.",
    ),
  );

export class SchoolSurveysApi extends HttpApiGroup.make("surveys")
  .add(ReadSchoolSurveyEndpoint)
  .add(SubmitSchoolSurveyResponseEndpoint)
  .add(ReadAdminCatalogEndpoint)
  .add(ListAdminSurveysEndpoint)
  .add(CreateAdminSurveyEndpoint)
  .add(CloseAdminSurveyEndpoint)
  .add(ReadAdminResultsEndpoint)
  .add(ExportAdminResultsEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "School surveys",
      description: "Anonymous participation and authorized administration of School surveys.",
    }),
  ) {}
