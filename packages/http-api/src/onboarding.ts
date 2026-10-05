import {
  OnboardingScope,
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
  RequirementId,
} from "@vektorprogrammet/domain/authz";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { command, readBoard } from "../.effx/generated/onboarding-contract.js";
import { annotateAccessSpec } from "./access.js";
import { operationAnnotations } from "./common.js";
import { OnboardingClaimProblem } from "./endpoint-problems.js";
import { privateReadResponse, endpointProblemResponses } from "./http-semantics.js";

export { OnboardingClaim, OnboardingCommand, OnboardingScope };

export const ClaimOnboardingEndpoint = HttpApiEndpoint.post("claim", "/api/onboarding/claim", {
  payload: OnboardingClaim,
  success: privateReadResponse(OnboardingClaimResult),
  error: endpointProblemResponses(OnboardingClaimProblem),
})
  .pipe((e) =>
    annotateAccessSpec(
      e,
      // New-account mode: the token holder is the principal. Existing-account mode: the
      // browser session names the principal, and the token is its requirement. A delegated
      // bearer cannot make the claim, so the AccessSpec does not accept one.
      makeAccessSpec({
        exposure: "External",
        acceptedCredentials: [
          CredentialMechanismSchema.cases.ObjectCapability.make({
            capabilityType: CapabilityTypeId.make("onboarding.claim"),
          }),
          CredentialMechanismSchema.cases.BetterAuthCookie.make({}),
        ],
        principalKinds: ["CapabilityHolder", "Person"],
        capabilities: CapabilityExpressionSchema.cases.One.make({
          capability: { type: CapabilityTypeId.make("onboarding.claim") },
        }),
        requirements: [{ id: RequirementId.make("onboarding.claim-token"), parameters: {} }],
        canonicalScopeResolver: "onboarding.claim",
        concealment: ConcealmentPolicySchema.cases.Reveal.make({}),
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Claim applicant account invitation",
      "The body token is required in both modes and works once. In new-account mode the token is the one credential, so a session cookie or bearer beside it is rejected. In existing-account mode the browser session names the one principal, and the token is its requirement onboarding.claim-token: it must name an open invitation. A delegated bearer cannot make the claim.",
    ),
  );

export class OnboardingApi extends HttpApiGroup.make("onboarding")
  .add(readBoard)
  .add(command)
  .add(ClaimOnboardingEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Applicant account onboarding",
      description: "Explicit applicant identity proof and account linking.",
    }),
  ) {}
