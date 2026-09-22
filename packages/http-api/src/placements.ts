import {
  Affiliation,
  AffiliationScope,
  OwnAffiliationCommand,
  PlacementBoard,
  PlacementCommand,
  PlacementScope,
  PlacementScopes,
} from "@vektorprogrammet/domain/placements";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, personNativeAccess } from "./access.js";
import { operationAnnotations, PersonSecurity } from "./common.js";
import {
  StrongETag,
  IdempotencyIfMatchHeaders,
  privateReadResponse,
  entityMutationResponse,
  endpointProblemResponses,
  problemUnion,
} from "./http-semantics.js";
export { AffiliationScope, OwnAffiliationCommand, PlacementCommand, PlacementScope };

export const OwnAffiliationResource = Schema.Struct({
  ...Affiliation.fields,
  etag: StrongETag,
}).annotate({ identifier: "OwnAffiliationResource" });
export const PlacementBoardResource = Schema.Struct({
  ...PlacementBoard.fields,
  etag: StrongETag,
}).annotate({ identifier: "PlacementBoardResource" });
export const PlacementProblem = problemUnion("PlacementProblem", [
  ["request.malformed", 400],
  ["request.too-large", 413],
  ["precondition.invalid", 400],
  ["idempotency-key.invalid", 400],
  ["header.malformed", 400],
  ["validation.failed", 422],
  ["scope.invalid", 422],
  ["credential.invalid", 401],
  ["authority.denied", 403],
  ["resource.not-found", 404],
  ["affiliation.transition-invalid", 422],
  ["affiliation.inactive", 422],
  ["placement.overlap", 409],
  ["placement.inactive", 422],
  ["school-service.proposal-empty", 422],
  ["school-service.proposal-inactive", 422],
  ["school-service.exception-review-invalid", 422],
  ["school-service.occurrence-invalid", 422],
  ["school-service.occurrence-duplicate", 409],
  ["precondition.required", 428],
  ["precondition.failed", 412],
  ["idempotency.in-flight", 409],
  ["idempotency.digest-conflict", 409],
  ["idempotency.response-expired", 409],
  ["transaction.conflict", 409],
  ["internal.error", 500],
  ["media-type.unsupported", 415],
]);
const access = (capability: "placements.self" | "placements.manage", write = false) =>
  personNativeAccess({
    capability,
    canonicalScopeResolver: "placements.explicit-department",
    decisionTime: write ? "Transaction" : "SnapshotRead",
  });
export const ListPlacementScopesEndpoint = HttpApiEndpoint.get(
  "listScopes",
  "/api/placements/scopes",
  {
    success: privateReadResponse(PlacementScopes),
    error: endpointProblemResponses(PlacementProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("placements.self")))
  .annotateMerge(
    operationAnnotations(
      "Select placement department and semester",
      "Public department labels and canonical semesters; private candidate names require coordinator authority.",
    ),
  );
export const ReadOwnAffiliationEndpoint = HttpApiEndpoint.get(
  "readOwnAffiliation",
  "/api/placements/affiliation",
  {
    query: AffiliationScope.fields,
    success: privateReadResponse(OwnAffiliationResource),
    error: endpointProblemResponses(PlacementProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("placements.self")))
  .annotateMerge(
    operationAnnotations("Read own affiliation", "Authenticated Person only; no person selector."),
  );
export const CommandOwnAffiliationEndpoint = HttpApiEndpoint.post(
  "commandOwnAffiliation",
  "/api/placements/affiliation",
  {
    query: AffiliationScope.fields,
    headers: IdempotencyIfMatchHeaders,
    payload: OwnAffiliationCommand,
    success: entityMutationResponse(OwnAffiliationResource),
    error: endpointProblemResponses(PlacementProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("placements.self", true)))
  .annotateMerge(
    operationAnnotations(
      "Request or withdraw own affiliation",
      "Self nomination gives scoped coordinators permission to discover this person.",
    ),
  );
export const ReadPlacementBoardEndpoint = HttpApiEndpoint.get("readBoard", "/api/placements", {
  query: PlacementScope.fields,
  success: privateReadResponse(PlacementBoardResource),
  error: endpointProblemResponses(PlacementProblem),
})
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("placements.manage")))
  .annotateMerge(
    operationAnnotations(
      "Read placement board",
      "Only active department leaders or global administrators.",
    ),
  );
export const CommandPlacementBoardEndpoint = HttpApiEndpoint.post(
  "commandBoard",
  "/api/placements",
  {
    query: PlacementScope.fields,
    headers: IdempotencyIfMatchHeaders,
    payload: PlacementCommand,
    success: entityMutationResponse(PlacementBoardResource),
    error: endpointProblemResponses(PlacementProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("placements.manage", true)))
  .annotateMerge(
    operationAnnotations(
      "Manage volunteer placement and school service",
      "Conditional audited commands; demand, proposal, confirmation, notification, occurrence, and placement scope stay transaction-bound.",
    ),
  );
export class PlacementsApi extends HttpApiGroup.make("placements")
  .add(ListPlacementScopesEndpoint)
  .add(ReadOwnAffiliationEndpoint)
  .add(CommandOwnAffiliationEndpoint)
  .add(ReadPlacementBoardEndpoint)
  .add(CommandPlacementBoardEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Volunteer placement",
      description:
        "Explicit affiliation, placement, demand, human-confirmed roster, and teaching occurrence.",
    }),
  ) {}
