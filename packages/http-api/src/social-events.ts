import {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventId,
  SocialEventListResource,
  SocialEventObservedAt,
  SocialEventResource,
  SocialEventScope,
  SocialEventScopeResource,
} from "@vektorprogrammet/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec } from "./access.js";
import { operationAnnotations, PersonSecurity } from "./common.js";
import {
  createdMutationResponse,
  endpointProblemResponses,
  IdempotencyHeaders,
  privateReadResponse,
  problemUnion,
  type NativeProblemCode,
} from "./http-semantics.js";
import { socialEventsPersonAccess } from "./social-events-effx-adapters.js";

export {
  CreateSocialEventRequest,
  SocialEventAudience,
  SocialEventId,
  SocialEventListResource,
  SocialEventObservedAt,
  SocialEventResource,
  SocialEventScope,
  SocialEventScopeResource,
};

/** The exported query schema reuses the domain scope fields without new wire members. */
export const SocialEventScopeQuery = Schema.Struct(SocialEventScope.fields);

export const SocialEventsReadScopeCodes = [
  "request.malformed",
  "header.malformed",
  "authority.denied",
  "origin.denied",
  "internal.error",
  "dependency.unavailable",
  "organization.unavailable",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const SocialEventsReadScopeProblem = problemUnion(
  "SocialEventsReadScopeProblem",
  SocialEventsReadScopeCodes,
);

export const SocialEventsListCodes = [
  "request.malformed",
  "header.malformed",
  "authority.denied",
  "origin.denied",
  "scope.invalid",
  "internal.error",
  "dependency.unavailable",
  "organization.unavailable",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const SocialEventsListProblem = problemUnion(
  "SocialEventsListProblem",
  SocialEventsListCodes,
);

export const SocialEventsCreateCodes = [
  "request.malformed",
  "header.malformed",
  "authority.denied",
  "origin.denied",
  "idempotency-key.invalid",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "request.too-large",
  "media-type.unsupported",
  "validation.failed",
  "scope.invalid",
  "internal.error",
  "dependency.unavailable",
  "organization.unavailable",
  "idempotency.unavailable",
  "transaction.conflict",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const SocialEventsCreateProblem = problemUnion(
  "SocialEventsCreateProblem",
  SocialEventsCreateCodes,
);

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
    annotateAccessSpec(endpoint, socialEventsPersonAccess("social-events.read-scope")),
  )
  .annotateMerge(
    operationAnnotations(
      "Read social event scope",
      "Returns the caller's authorized departments and canonical semesters.",
    ),
  );

/** @since 0.2.0 @category Endpoints */
export const ListSocialEventsEndpoint = HttpApiEndpoint.get("list", "/api/social-events", {
  query: SocialEventScopeQuery,
  success: privateReadResponse(SocialEventListResource),
  error: endpointProblemResponses(SocialEventsListProblem),
})
  .middleware(PersonSecurity)
  .pipe((endpoint) => annotateAccessSpec(endpoint, socialEventsPersonAccess("social-events.read")))
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
    annotateAccessSpec(endpoint, socialEventsPersonAccess("social-events.create")),
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
