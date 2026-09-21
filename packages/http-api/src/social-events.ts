import {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventListResource,
  SocialEventResource,
  SocialEventScope,
  SocialEventScopeResource,
} from "@vektorprogrammet/domain";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, personNativeAccess } from "./access.js";
import { operationAnnotations, PersonSecurity } from "./common.js";
import {
  createdMutationResponse,
  endpointProblemResponses,
  IdempotencyHeaders,
  privateReadResponse,
  problemUnion,
} from "./http-semantics.js";

export {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventListResource,
  SocialEventResource,
  SocialEventScope,
  SocialEventScopeResource,
};

export const SocialEventsReadScopeProblem = problemUnion("SocialEventsReadScopeProblem", [
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

export const SocialEventsListProblem = problemUnion("SocialEventsListProblem", [
  ["request.malformed", 400],
  ["header.malformed", 400],
  ["credential.missing", 401],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["origin.denied", 403],
  ["scope.invalid", 422],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["organization.unavailable", 503],
]);

export const SocialEventsCreateProblem = problemUnion("SocialEventsCreateProblem", [
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
  ["validation.failed", 422],
  ["scope.invalid", 422],
  ["internal.error", 500],
  ["dependency.unavailable", 503],
  ["organization.unavailable", 503],
  ["idempotency.unavailable", 503],
]);

/** @since 0.2.0 @category Endpoints */
export const ReadSocialEventScopeEndpoint = HttpApiEndpoint.get(
  "readScope",
  "/api/social-events/scope",
  {
    success: privateReadResponse(SocialEventScopeResource),
    error: endpointProblemResponses(SocialEventsReadScopeProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "social-events.read-scope",
        canonicalScopeResolver: "social-events.scope",
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Read social event scope",
      "Returns the caller's authorized departments and canonical semesters.",
    ),
  );

/** @since 0.2.0 @category Endpoints */
export const ListSocialEventsEndpoint = HttpApiEndpoint.get("list", "/api/social-events", {
  query: SocialEventScope.fields,
  success: privateReadResponse(SocialEventListResource),
  error: endpointProblemResponses(SocialEventsListProblem),
})
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "social-events.read",
        canonicalScopeResolver: "social-events.list",
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "List social events",
      "Returns social events in one authorized department and semester scope.",
    ),
  );

/** @since 0.2.0 @category Endpoints */
export const CreateSocialEventEndpoint = HttpApiEndpoint.post("create", "/api/social-events", {
  headers: IdempotencyHeaders,
  payload: CreateSocialEventRequest,
  success: createdMutationResponse(SocialEventResource.pipe(HttpApiSchema.status(201))),
  error: endpointProblemResponses(SocialEventsCreateProblem),
})
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "social-events.create",
        canonicalScopeResolver: "social-events.create",
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("Create social event", "Creates or replays one social event command."),
  );

export class SocialEventsApi extends HttpApiGroup.make("social-events")
  .add(ReadSocialEventScopeEndpoint)
  .add(ListSocialEventsEndpoint)
  .add(CreateSocialEventEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Social events",
      description: "Department and semester scoped team social events.",
    }),
  ) {}
