import {
  OnboardingScope,
  OnboardingBoard,
  OnboardingCommand,
  OnboardingClaim,
  OnboardingClaimResult,
} from "@vektorprogrammet/domain/onboarding";
import {
  makeAccessSpec,
  CapabilityTypeId,
  CredentialMechanismSchema,
  CapabilityExpressionSchema,
  ConcealmentPolicySchema,
} from "@vektorprogrammet/domain/authz";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, personNativeAccess } from "./access.js";
import { PersonSecurity, operationAnnotations } from "./common.js";
import {
  StrongETag,
  IdempotencyIfMatchHeaders,
  privateReadResponse,
  entityMutationResponse,
  endpointProblemResponses,
  problemUnion,
} from "./http-semantics.js";

export { OnboardingClaim, OnboardingCommand, OnboardingScope };

export const OnboardingResource = Schema.Struct({
  ...OnboardingBoard.fields,
  etag: StrongETag,
}).annotate({ identifier: "OnboardingResource" });

export const OnboardingProblem = problemUnion("OnboardingProblem", [
  "request.malformed",
  "request.too-large",
  "validation.failed",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "precondition.required",
  "precondition.invalid",
  "precondition.failed",
  "idempotency-key.invalid",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "media-type.unsupported",
  "onboarding.claim-invalid",
  "onboarding.sign-in-required",
  "onboarding.already-linked",
]);

const access = (write = false) =>
  personNativeAccess({
    capability: "onboarding.manage",
    canonicalScopeResolver: "onboarding.application-department",
    decisionTime: write ? "Transaction" : "SnapshotRead",
  });

export const ReadOnboardingEndpoint = HttpApiEndpoint.get("readBoard", "/api/onboarding", {
  query: OnboardingScope.fields,
  success: privateReadResponse(OnboardingResource),
  error: endpointProblemResponses(OnboardingProblem),
})
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access()))
  .annotateMerge(
    operationAnnotations(
      "Read applicant onboarding",
      "Scoped applicant names and invitation states.",
    ),
  );

export const CommandOnboardingEndpoint = HttpApiEndpoint.post("command", "/api/onboarding", {
  query: OnboardingScope.fields,
  payload: OnboardingCommand,
  headers: IdempotencyIfMatchHeaders,
  success: entityMutationResponse(OnboardingResource),
  error: endpointProblemResponses(OnboardingProblem),
})
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access(true)))
  .annotateMerge(
    operationAnnotations(
      "Invite applicant or revoke invitation",
      "No arbitrary recipient or target Person selector.",
    ),
  );

export const ClaimOnboardingEndpoint = HttpApiEndpoint.post("claim", "/api/onboarding/claim", {
  payload: OnboardingClaim,
  success: privateReadResponse(OnboardingClaimResult),
  error: endpointProblemResponses(OnboardingProblem),
})
  .pipe((e) =>
    annotateAccessSpec(
      e,
      makeAccessSpec({
        exposure: "External",
        acceptedCredentials: [
          CredentialMechanismSchema.cases.ObjectCapability.make({
            capabilityType: CapabilityTypeId.make("onboarding.claim"),
          }),
        ],
        principalKinds: ["CapabilityHolder"],
        capabilities: CapabilityExpressionSchema.cases.One.make({
          capability: { type: CapabilityTypeId.make("onboarding.claim") },
        }),
        requirements: [],
        canonicalScopeResolver: "onboarding.claim",
        concealment: ConcealmentPolicySchema.cases.Reveal.make({}),
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Claim applicant account invitation",
      "A purpose-specific token in the body is required; existing-account mode additionally requires an authenticated Person.",
    ),
  );

export class OnboardingApi extends HttpApiGroup.make("onboarding")
  .add(ReadOnboardingEndpoint)
  .add(CommandOnboardingEndpoint)
  .add(ClaimOnboardingEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Applicant account onboarding",
      description: "Explicit applicant identity proof and account linking.",
    }),
  ) {}
