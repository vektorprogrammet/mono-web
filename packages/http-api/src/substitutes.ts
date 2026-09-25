import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import {
  SubstituteEntry,
  SubstituteMutation,
  SubstituteScope,
  SubstituteScopes,
} from "@vektorprogrammet/domain/substitutes";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, personNativeAccess } from "./access.js";
import { operationAnnotations, PersonSecurity } from "./common.js";
import {
  ConditionalReadHeaders,
  StrongETag,
  IdempotencyIfMatchHeaders,
  privateReadResponse,
  privateConditionalResponses,
  entityMutationResponse,
  endpointProblemResponses,
  problemUnion,
} from "./http-semantics.js";

export { SubstituteMutation };

export const ActiveSubstituteResource = Schema.Struct({
  ...SubstituteEntry.members[0].fields,
  etag: StrongETag,
});

export const InactiveSubstituteResource = Schema.Struct({
  ...SubstituteEntry.members[1].fields,
  etag: StrongETag,
});

export const SubstituteResource = Schema.Union([
  ActiveSubstituteResource,
  InactiveSubstituteResource,
]).annotate({ identifier: "SubstituteResource" });

const BoardFields = {
  ...SubstituteScope.fields,
  admissionPeriodId: Schema.NullOr(AdmissionPeriodId),
  entries: Schema.Array(ActiveSubstituteResource),
};

export const SubstituteBoard = Schema.TaggedUnion({
  ReadOnly: BoardFields,
  Manage: { ...BoardFields, candidates: Schema.Array(InactiveSubstituteResource) },
}).annotate({ identifier: "SubstituteBoard" });

export const SubstituteProblem = problemUnion("SubstituteProblem", [
  "request.malformed",
  "request.too-large",
  "precondition.invalid",
  "idempotency-key.invalid",
  "header.malformed",
  "validation.failed",
  "scope.invalid",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "substitute.already-active",
  "substitute.inactive",
  "precondition.required",
  "precondition.failed",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "media-type.unsupported",
]);

const access = (write: boolean) =>
  personNativeAccess({
    capability: write ? "substitutes.manage" : "substitutes.read",
    canonicalScopeResolver: "substitutes.application-scope",
    decisionTime: write ? "Transaction" : "SnapshotRead",
  });

export const ListSubstituteScopesEndpoint = HttpApiEndpoint.get(
  "listScopes",
  "/api/substitutes/scopes",
  {
    success: privateReadResponse(SubstituteScopes),
    error: endpointProblemResponses(SubstituteProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access(false)))
  .annotateMerge(
    operationAnnotations(
      "Select substitute scope",
      "Authorized departments and canonical historical semesters.",
    ),
  );

export const ReadSubstitutePoolEndpoint = HttpApiEndpoint.get("readPool", "/api/substitutes", {
  query: SubstituteScope.fields,
  success: privateReadResponse(SubstituteBoard),
  error: endpointProblemResponses(SubstituteProblem),
})
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access(false)))
  .annotateMerge(
    operationAnnotations(
      "Read substitute pool",
      "Only leaders receive inactive candidate applications.",
    ),
  );

export const ReadSubstituteEndpoint = HttpApiEndpoint.get(
  "readEntry",
  "/api/substitutes/:applicationId",
  {
    params: { applicationId: PublicApplicationIdSchema },
    headers: ConditionalReadHeaders,
    success: privateConditionalResponses(SubstituteResource),
    error: endpointProblemResponses(SubstituteProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access(false)))
  .annotateMerge(
    operationAnnotations(
      "Select substitute entry",
      "Members can select only active entries; leaders can select candidates.",
    ),
  );

export const ActivateSubstituteEndpoint = HttpApiEndpoint.post(
  "activate",
  "/api/substitutes/:applicationId:activate",
  {
    params: { applicationId: PublicApplicationIdSchema },
    headers: IdempotencyIfMatchHeaders,
    payload: SubstituteMutation,
    success: entityMutationResponse(SubstituteResource),
    error: endpointProblemResponses(SubstituteProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access(true)))
  .annotateMerge(
    operationAnnotations(
      "Activate substitute",
      "Explicit preferences are required. Fresh activation of an active entry rejects.",
    ),
  );

export const EditSubstituteEndpoint = HttpApiEndpoint.post(
  "edit",
  "/api/substitutes/:applicationId:edit",
  {
    params: { applicationId: PublicApplicationIdSchema },
    headers: IdempotencyIfMatchHeaders,
    payload: SubstituteMutation,
    success: entityMutationResponse(SubstituteResource),
    error: endpointProblemResponses(SubstituteProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access(true)))
  .annotateMerge(
    operationAnnotations(
      "Edit substitute",
      "Updates declared preferences and the canonical application year of study.",
    ),
  );

export const DeactivateSubstituteEndpoint = HttpApiEndpoint.post(
  "deactivate",
  "/api/substitutes/:applicationId:deactivate",
  {
    params: { applicationId: PublicApplicationIdSchema },
    headers: IdempotencyIfMatchHeaders,
    payload: Schema.Struct({}),
    success: entityMutationResponse(SubstituteResource),
    error: endpointProblemResponses(SubstituteProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access(true)))
  .annotateMerge(
    operationAnnotations(
      "Deactivate substitute",
      "Preserves application, recruitment history and preferences; fresh inactive deactivation rejects.",
    ),
  );

export class SubstitutesApi extends HttpApiGroup.make("substitutes")
  .add(ListSubstituteScopesEndpoint)
  .add(ReadSubstitutePoolEndpoint)
  .add(ReadSubstituteEndpoint)
  .add(ActivateSubstituteEndpoint)
  .add(EditSubstituteEndpoint)
  .add(DeactivateSubstituteEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Substitute pool",
      description: "Department and semester scoped substitute availability.",
    }),
  ) {}
