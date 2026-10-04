import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import { type SCOPE_RESOLVER_IDS } from "@vektorprogrammet/domain/authz";
import { Predicate, Schema } from "effect";
import { accessSpecAnnotations, personNativeAccess } from "./access.js";
import type { NativeProblemCode } from "./http-semantics.js";

/**
 * Flat literal copies of the three ordered problem lists of `admission-outcomes.ts`, which owns
 * the order. The effx frontend resolves a literal tuple but not a spread of a const tuple, so the
 * declarations cannot use the composed lists. `admission-outcomes-effx-adapters.test.ts` compares
 * each copy with its source element for element and at the type level, so neither can drift.
 * Retire these copies when the frontend resolves a spread of a const tuple.
 */
export const AdmissionOutcomeReadCodes = [
  "request.malformed",
  "request.too-large",
  "precondition.invalid",
  "idempotency-key.invalid",
  "header.malformed",
  "validation.failed",
  "scope.invalid",
  "authority.denied",
  "resource.not-found",
  "precondition.required",
  "precondition.failed",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "media-type.unsupported",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const AdmissionOutcomeCommandCodes = [
  "request.malformed",
  "request.too-large",
  "precondition.invalid",
  "idempotency-key.invalid",
  "header.malformed",
  "validation.failed",
  "scope.invalid",
  "authority.denied",
  "resource.not-found",
  "precondition.required",
  "precondition.failed",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "media-type.unsupported",
  "idempotency.unavailable",
  "admission-outcome.undecided",
  "admission-outcome.placement-active",
  "admission-outcome.final",
  "admission-outcome.derived",
  "admission-outcome.unreviewed",
  "admission-outcome.template-invalid",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const AdmissionOutcomeTemplateCodes = [
  "request.malformed",
  "request.too-large",
  "precondition.invalid",
  "idempotency-key.invalid",
  "header.malformed",
  "validation.failed",
  "scope.invalid",
  "authority.denied",
  "resource.not-found",
  "precondition.required",
  "precondition.failed",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "media-type.unsupported",
  "admission-outcome.template-invalid",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

/** The exported identities bind each declared resolver to its current authority projection. */
export const AdmissionOutcomesApplicationOutcomesResolver = {
  id: "admissions.application-outcomes",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const AdmissionOutcomesAnnouncementResolver = {
  id: "admissions.outcome-announcement",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const AdmissionOutcomesTemplatesResolver = {
  id: "admissions.outcome-templates",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

type OutcomeResolver = { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

type OutcomePolicy = {
  /** One capability, or the ordered capabilities of which any one grants the operation. */
  readonly capabilities: readonly [string, ...string[]];
  readonly resolver: OutcomeResolver;
  readonly requirements: readonly ["admissions.department-coordinator"] | readonly [];
  readonly decisionTime: "SnapshotRead" | "Transaction";
};

/** The eight approved operations; an access outside this table is refused when it is annotated. */
const policies: ReadonlyArray<OutcomePolicy> = [
  {
    capabilities: ["admissions.outcomes.read", "admissions.outcomes.announce"],
    resolver: AdmissionOutcomesApplicationOutcomesResolver,
    requirements: [],
    decisionTime: "SnapshotRead",
  },
  {
    capabilities: ["admissions.outcomes.read"],
    resolver: AdmissionOutcomesApplicationOutcomesResolver,
    requirements: [],
    decisionTime: "SnapshotRead",
  },
  {
    capabilities: ["admissions.outcomes.decide"],
    resolver: AdmissionOutcomesApplicationOutcomesResolver,
    requirements: [],
    decisionTime: "Transaction",
  },
  {
    capabilities: ["admissions.outcomes.announce"],
    resolver: AdmissionOutcomesAnnouncementResolver,
    requirements: ["admissions.department-coordinator"],
    decisionTime: "Transaction",
  },
  {
    capabilities: ["admissions.outcome-templates.read"],
    resolver: AdmissionOutcomesTemplatesResolver,
    requirements: [],
    decisionTime: "SnapshotRead",
  },
  {
    capabilities: ["admissions.outcome-templates.edit"],
    resolver: AdmissionOutcomesTemplatesResolver,
    requirements: [],
    decisionTime: "SnapshotRead",
  },
  {
    capabilities: ["admissions.outcome-templates.edit"],
    resolver: AdmissionOutcomesTemplatesResolver,
    requirements: [],
    decisionTime: "Transaction",
  },
];

const resolverSymbol = <R extends OutcomeResolver>(symbol: R) =>
  Schema.declare((value: unknown): value is R => value === symbol);

const OutcomeCapability = Schema.Literals([
  "admissions.outcomes.read",
  "admissions.outcomes.decide",
  "admissions.outcomes.announce",
  "admissions.outcome-templates.read",
  "admissions.outcome-templates.edit",
]);

const AdmissionOutcomesAccess = Schema.Struct({
  exposure: Schema.Literal("External"),
  acceptedCredentials: Schema.Tuple([
    Schema.Literal("BetterAuthCookie"),
    Schema.Literal("OAuthUserBearer"),
  ]),
  principalKinds: Schema.Tuple([Schema.Literal("Person")]),
  capabilities: Schema.Union([
    Schema.TaggedStruct("One", { capability: OutcomeCapability }),
    Schema.TaggedStruct("Any", {
      capabilities: Schema.Tuple([OutcomeCapability, OutcomeCapability]),
    }),
  ]),
  requirements: Schema.Array(
    Schema.Struct({
      id: Schema.Literal("admissions.department-coordinator"),
      parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.Never)),
    }),
  ),
  canonicalScopeResolver: Schema.Union([
    resolverSymbol(AdmissionOutcomesApplicationOutcomesResolver),
    resolverSymbol(AdmissionOutcomesAnnouncementResolver),
    resolverSymbol(AdmissionOutcomesTemplatesResolver),
  ]),
  concealment: Schema.TaggedStruct("Reveal", {}),
  decisionTime: Schema.Literals(["SnapshotRead", "Transaction"]),
}).pipe(
  Schema.check(
    Schema.makeFilter((spec) => {
      const declared = Predicate.isTagged(spec.capabilities, "One")
        ? [spec.capabilities.capability]
        : spec.capabilities.capabilities;

      return policies.some(
        (policy) =>
          policy.resolver === spec.canonicalScopeResolver &&
          policy.decisionTime === spec.decisionTime &&
          policy.capabilities.length === declared.length &&
          policy.capabilities.every((capability, index) => declared[index] === capability) &&
          policy.requirements.length === spec.requirements.length &&
          policy.requirements.every((id, index) => spec.requirements[index]?.id === id),
      );
    }),
  ),
);

const decodeAdmissionOutcomesAccess = Schema.decodeUnknownSync(AdmissionOutcomesAccess, {
  onExcessProperty: "error",
});

/** Projects only the eight approved operations onto the existing native AccessSpec. */
export const admissionOutcomesAccessAnnotations = (input: HttpAccessAnnotationSpec) => {
  const spec = decodeAdmissionOutcomesAccess(input);
  const requirements = spec.requirements.map(({ id }) => id);

  if (Predicate.isTagged(spec.capabilities, "One")) {
    return accessSpecAnnotations(
      personNativeAccess({
        capability: spec.capabilities.capability,
        canonicalScopeResolver: spec.canonicalScopeResolver.id,
        requirements,
        decisionTime: spec.decisionTime,
      }),
    );
  }

  const [capability, alternative] = spec.capabilities.capabilities;

  return accessSpecAnnotations(
    personNativeAccess({
      capability,
      alternatives: [alternative],
      canonicalScopeResolver: spec.canonicalScopeResolver.id,
      requirements,
      decisionTime: spec.decisionTime,
    }),
  );
};
