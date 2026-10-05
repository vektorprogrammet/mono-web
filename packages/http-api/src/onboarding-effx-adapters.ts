import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import type { SCOPE_RESOLVER_IDS } from "@vektorprogrammet/domain/authz";
import { OnboardingBoard } from "@vektorprogrammet/domain/onboarding";
import { Schema } from "effect";
import { accessSpecAnnotations, personNativeAccess } from "./access.js";
import type { OnboardingCommandCodes } from "./endpoint-problems.js";
import { StrongETag } from "./http-semantics.js";

/** The repaired board, including server-owned canIssue readiness, and its whole-board validator. */
export const OnboardingResource = Schema.Struct({
  ...OnboardingBoard.fields,
  etag: StrongETag,
}).annotate({ identifier: "OnboardingResource" });

/**
 * The authoritative OnboardingCommandCodes tuple is spread-composed in endpoint-problems.ts.
 * The effx frontend needs a flat literal tuple. The satisfies constraint and the adapter test
 * require element-for-element, order-sensitive equality with that source, including a reordered
 * negative control. Retire this derived copy when the frontend resolves const-tuple spreads.
 */
export const OnboardingCommandDeclarationCodes = [
  "request.malformed",
  "request.too-large",
  "validation.failed",
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
  "idempotency.unavailable",
  "onboarding.not-admitted",
  "onboarding.delivery-not-retryable",
  "dependency.unavailable",
] as const satisfies typeof OnboardingCommandCodes;

/** This symbol selects the existing application-department authority projection, not a new one. */
export const OnboardingApplicationDepartmentResolver = {
  id: "onboarding.application-department",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

const Resolver = Schema.Unknown.pipe(
  Schema.check(
    Schema.makeFilter((value) => value === OnboardingApplicationDepartmentResolver, {
      message: "the exported OnboardingApplicationDepartmentResolver symbol",
    }),
  ),
);

const accessAnnotations = (decisionTime: "SnapshotRead" | "Transaction") => {
  const decodeAccess = Schema.decodeUnknownSync(
    Schema.Struct({
      exposure: Schema.Literal("External"),
      acceptedCredentials: Schema.Tuple([
        Schema.Literal("BetterAuthCookie"),
        Schema.Literal("OAuthUserBearer"),
      ]),
      principalKinds: Schema.Tuple([Schema.Literal("Person")]),
      capabilities: Schema.TaggedStruct("One", {
        capability: Schema.Literal("onboarding.manage"),
      }),
      requirements: Schema.Tuple([]),
      canonicalScopeResolver: Resolver,
      concealment: Schema.TaggedStruct("Reveal", {}),
      decisionTime: Schema.Literal(decisionTime),
    }),
    { onExcessProperty: "error" },
  );

  return (input: HttpAccessAnnotationSpec) => {
    const spec = decodeAccess(input);

    return accessSpecAnnotations(
      personNativeAccess({
        capability: spec.capabilities.capability,
        canonicalScopeResolver: OnboardingApplicationDepartmentResolver.id,
        decisionTime: spec.decisionTime,
      }),
    );
  };
};

/** Only the original Person read policy, evaluated in the board's authority snapshot. */
export const onboardingReadAccessAnnotations = accessAnnotations("SnapshotRead");

/** Only the original Person command policy, evaluated before replay in its transaction. */
export const onboardingCommandAccessAnnotations = accessAnnotations("Transaction");
