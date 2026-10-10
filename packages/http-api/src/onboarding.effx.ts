import { Capability, Concealment, Http, Operation } from "@effx/runtime";
import { OnboardingCommand, OnboardingScope } from "@vektorprogrammet/domain/onboarding";
import { ExternalNativeApi } from "./api.js";
import { nativeOperationAnnotations, PersonSecurity } from "./common.js";
import { nativeProblems, OnboardingCodes } from "./endpoint-problems.js";
import {
  EntityMutationResponseHeaders,
  IdempotencyIfMatchHeaders,
  PrivateReadResponseHeaders,
} from "./http-semantics.js";
import {
  OnboardingApplicationDepartmentResolver,
  OnboardingCommandDeclarationCodes,
  onboardingCommandAccessAnnotations,
  onboardingReadAccessAnnotations,
  OnboardingResource,
} from "./onboarding-effx-adapters.js";

/** Recruitment's two endpoints join the existing mixed Recruitment/Identity group. */
export const OnboardingGroup = Http.group({
  root: ExternalNativeApi,
  group: "onboarding",
  title: "Applicant account onboarding",
  description: "Explicit applicant identity proof and account linking.",
  defaults: {
    middleware: [PersonSecurity],
    metadata: { annotator: nativeOperationAnnotations },
    problems: { registry: nativeProblems },
    access: {
      exposure: "External",
      acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
      principalKinds: ["Person"],
      concealment: Concealment.reveal,
    },
  },
});

export const ReadBoard = Operation.query({
  name: "onboarding.readBoard",
  input: OnboardingScope,
  success: OnboardingResource,
})
  .in(OnboardingGroup)
  .http.get("/api/onboarding")
  .http.contract({
    query: OnboardingScope,
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    metadata: {
      summary: "Read applicant onboarding",
      description: "Scoped applicant names and invitation states.",
    },
  })
  .http.problems({
    identifier: "OnboardingProblem",
    codes: OnboardingCodes,
  })
  .http.access({
    annotator: onboardingReadAccessAnnotations,
    capabilities: Capability.one("onboarding.manage"),
    requirements: [],
    canonicalScopeResolver: OnboardingApplicationDepartmentResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const Command = Operation.command({
  name: "onboarding.command",
  input: OnboardingCommand,
  success: OnboardingResource,
})
  .in(OnboardingGroup)
  .http.post("/api/onboarding")
  .http.contract({
    query: OnboardingScope,
    payload: OnboardingCommand,
    headers: IdempotencyIfMatchHeaders,
    status: 200,
    responseHeaders: EntityMutationResponseHeaders,
    metadata: {
      summary: "Invite applicant or revoke invitation",
      description: "No arbitrary recipient or target Person selector.",
    },
  })
  .http.problems({
    identifier: "OnboardingCommandProblem",
    codes: OnboardingCommandDeclarationCodes,
  })
  .http.access({
    annotator: onboardingCommandAccessAnnotations,
    capabilities: Capability.one("onboarding.manage"),
    requirements: [],
    canonicalScopeResolver: OnboardingApplicationDepartmentResolver,
    decisionTime: "Transaction",
  })
  .declare();
