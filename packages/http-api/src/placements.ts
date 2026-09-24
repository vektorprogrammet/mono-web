import {
  Affiliation,
  AffiliationScope,
  CoverageBoard,
  CoverageCommand,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  OwnCoverageView,
  PlacementBoard,
  PlacementCommand,
  PlacementScope,
  PlacementScopes,
} from "@vektorprogrammet/placements/contracts";
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

export {
  AffiliationScope,
  CoverageCommand,
  OwnAffiliationCommand,
  OwnCoverageCommand,
  PlacementCommand,
  PlacementScope,
  PlacementScopes,
};

export const OwnAffiliationResource = Schema.Struct({
  ...Affiliation.fields,
  etag: StrongETag,
}).annotate({ identifier: "OwnAffiliationResource" });

export const PlacementBoardResource = Schema.Struct({
  ...PlacementBoard.fields,
  etag: StrongETag,
}).annotate({ identifier: "PlacementBoardResource" });

export const OwnCoverageResource = Schema.Struct({
  ...OwnCoverageView.fields,
  etag: StrongETag,
}).annotate({ identifier: "OwnCoverageResource" });

export const CoverageBoardResource = Schema.Struct({
  ...CoverageBoard.fields,
  etag: StrongETag,
}).annotate({ identifier: "CoverageBoardResource" });

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
  ["commitment.target-invalid", 422],
  ["commitment.duplicate", 409],
  ["commitment.closed", 409],
  ["commitment.attendance-invalid", 422],
  ["commitment.outcome-invalid", 422],
  ["commitment.pending-offer", 409],
  ["commitment.interval-invalid", 422],
  ["absence.target-invalid", 422],
  ["absence.duplicate", 409],
  ["absence.closed", 409],
  ["offer.candidate-ineligible", 422],
  ["offer.unresolved", 409],
  ["offer.owner-invalid", 403],
  ["offer.response-invalid", 409],
  ["offer.withdraw-invalid", 409],
  ["coverage.acknowledgement-invalid", 409],

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
      "Manage placement and dated school service",
      "Commands keep demand, proposals, commitments, and placement changes inside one transaction.",
    ),
  );

export const ReadOwnCoverageEndpoint = HttpApiEndpoint.get(
  "readOwnCoverage",
  "/api/placements/coverage/own",
  {
    query: PlacementScope.fields,
    success: privateReadResponse(OwnCoverageResource),
    error: endpointProblemResponses(PlacementProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("placements.self")))
  .annotateMerge(
    operationAnnotations(
      "Read own coverage and scheduled service",
      "A person sees only commitments where they are scheduled or have acknowledged substitute coverage.",
    ),
  );

export const CommandOwnCoverageEndpoint = HttpApiEndpoint.post(
  "commandOwnCoverage",
  "/api/placements/coverage/own",
  {
    query: PlacementScope.fields,
    headers: IdempotencyIfMatchHeaders,
    payload: OwnCoverageCommand,
    success: entityMutationResponse(OwnCoverageResource),
    error: endpointProblemResponses(PlacementProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("placements.self", true)))
  .annotateMerge(
    operationAnnotations(
      "Report own absence or answer addressed offer",
      "The current person must own a scheduled assignment in an open commitment or be the addressed substitute.",
    ),
  );

export const ReadCoverageBoardEndpoint = HttpApiEndpoint.get(
  "readCoverageBoard",
  "/api/placements/coverage",
  {
    query: PlacementScope.fields,
    success: privateReadResponse(CoverageBoardResource),
    error: endpointProblemResponses(PlacementProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("placements.manage")))
  .annotateMerge(
    operationAnnotations(
      "Read coordinator coverage board",
      "Only a scoped coordinator can read candidates, offers, actual attendance, per-absence closures, and commitment outcomes.",
    ),
  );

export const CommandCoverageBoardEndpoint = HttpApiEndpoint.post(
  "commandCoverageBoard",
  "/api/placements/coverage",
  {
    query: PlacementScope.fields,
    headers: IdempotencyIfMatchHeaders,
    payload: CoverageCommand,
    success: entityMutationResponse(CoverageBoardResource),
    error: endpointProblemResponses(PlacementProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("placements.manage", true)))
  .annotateMerge(
    operationAnnotations(
      "Coordinate coverage and decide dated service",
      "Commands check coordinator scope, actual attendance, and immutable outcome evidence inside one transaction.",
    ),
  );

export class PlacementsApi extends HttpApiGroup.make("placements")
  .add(ListPlacementScopesEndpoint)
  .add(ReadOwnAffiliationEndpoint)
  .add(CommandOwnAffiliationEndpoint)
  .add(ReadPlacementBoardEndpoint)
  .add(CommandPlacementBoardEndpoint)
  .add(ReadOwnCoverageEndpoint)
  .add(CommandOwnCoverageEndpoint)
  .add(ReadCoverageBoardEndpoint)
  .add(CommandCoverageBoardEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Volunteer placement",
      description:
        "Explicit affiliation, placement, confirmed roster, dated school commitment, absence, substitute coverage, and immutable outcomes.",
    }),
  ) {}
