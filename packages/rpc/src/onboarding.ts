/**
 * Onboarding: coordinators invite admitted applicants to an account, and an applicant claims the
 * invitation.
 *
 * @since 0.3.0
 */
import {
  CapabilityExpressionSchema,
  CapabilityTypeId,
  ConcealmentPolicySchema,
  CredentialMechanismSchema,
  makeAccessSpec,
  RequirementId,
} from "@vektorprogrammet/domain/authz";
import {
  OnboardingBoard,
  OnboardingClaim,
  OnboardingClaimResult,
  OnboardingCommand,
  OnboardingScope,
} from "@vektorprogrammet/domain/onboarding";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";

export { OnboardingClaim, OnboardingClaimResult, OnboardingCommand, OnboardingScope };

/** A department's applicant names and invitation states, with the tag that a command names. */
export const OnboardingResource = Schema.Struct({
  ...OnboardingBoard.fields,
  etag: StrongETag,
}).annotate({ identifier: "OnboardingResource" });

export type OnboardingResource = typeof OnboardingResource.Type;

/** Problems of `onboarding.readBoard`. */
export const OnboardingReadBoardProblem = problemUnion("OnboardingReadBoardProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "transaction.conflict",
  "internal.error",
  "onboarding.claim-invalid",
  "onboarding.sign-in-required",
  "onboarding.already-linked",
]);

/** Problems of `onboarding.command`; its receipt store can also be unavailable. */
export const OnboardingCommandProblem = problemUnion("OnboardingCommandProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "precondition.failed",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "idempotency.unavailable",
  "onboarding.claim-invalid",
  "onboarding.sign-in-required",
  "onboarding.already-linked",
]);

/**
 * Problems of `onboarding.claim`. The claim has no credential middleware, so it answers its own
 * credential problems: an existing-account claim without the browser session, and a new-account
 * claim with a cookie or bearer beside its token.
 */
export const OnboardingClaimProblem = problemUnion("OnboardingClaimProblem", [
  "credential.missing",
  "credential.invalid",
  "resource.not-found",
  "transaction.conflict",
  "internal.error",
  "onboarding.claim-invalid",
  "onboarding.sign-in-required",
  "onboarding.already-linked",
]);

/** Applicant names and invitation states of one department. */
export const ReadOnboardingBoard = Rpc.make("onboarding.readBoard", {
  payload: OnboardingScope,
  success: OnboardingResource,
  error: rpcProblems(OnboardingReadBoardProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "onboarding.manage",
        canonicalScopeResolver: "onboarding.application-department",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * Invites an admitted applicant or revokes an invitation, or replays the command by its
 * idempotency key. It names no arbitrary recipient or target Person.
 */
export const CommandOnboarding = Rpc.make("onboarding.command", {
  payload: Schema.Struct({
    departmentId: OnboardingScope.fields.departmentId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: OnboardingCommand,
  }),
  success: OnboardingResource,
  error: rpcProblems(OnboardingCommandProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "onboarding.manage",
        canonicalScopeResolver: "onboarding.application-department",
        decisionTime: "Transaction",
      }),
    ),
  );

/**
 * Claims an applicant account invitation. The payload token is required in both modes and works
 * once. In new-account mode the token is the one credential, so a session cookie or bearer beside
 * it is rejected. In existing-account mode the browser session names the one principal, and the
 * token is its requirement `onboarding.claim-token`: it must name an open invitation. A delegated
 * bearer cannot make the claim.
 */
export const ClaimOnboarding = Rpc.make("onboarding.claim", {
  payload: OnboardingClaim,
  success: OnboardingClaimResult,
  error: rpcProblems(OnboardingClaimProblem),
}).pipe(
  withAccessSpec(
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
);

export class OnboardingRpcs extends RpcGroup.make(
  ReadOnboardingBoard,
  CommandOnboarding,
  ClaimOnboarding,
) {}
