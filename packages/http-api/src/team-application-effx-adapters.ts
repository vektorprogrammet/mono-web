import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import { type SCOPE_RESOLVER_IDS } from "@vektorprogrammet/domain/authz";
import { TeamId } from "@vektorprogrammet/domain/organization";
import {
  TeamApplicationCursor,
  TeamApplicationId,
} from "@vektorprogrammet/domain/team-application";
import { Predicate, Schema } from "effect";
import { accessSpecAnnotations, anonymousNativeAccess, personNativeAccess } from "./access.js";
import { noStoreReadResponse, type NativeProblemCode } from "./http-semantics.js";

/** Exported SchemaRefs for the existing route parameters and optional cursor. */
export const TeamApplicationEmptyInput = Schema.Struct({});

export const TeamApplicationTeamParams = Schema.Struct({ teamId: TeamId });

export const TeamApplicationParams = Schema.Struct({ applicationId: TeamApplicationId });

export const TeamApplicationListQuery = Schema.Struct({
  cursor: Schema.optional(TeamApplicationCursor),
});

/** The public reads and bodyless deletion share the existing no-store/Vary headers. */
export const TeamApplicationsNoStoreResponseHeaders = noStoreReadResponse(Schema.Void).headers;

// These tuples mirror the still-mounted handwritten unions. The adapter test compares their
// members in wire order until the seven-operation cutover removes the old declarations.
export const TeamApplicationsReadIntakeCodes = [
  "request.malformed",
  "header.malformed",
  "resource.not-found",
  "internal.error",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const TeamApplicationsListIntakesCodes = [
  "request.malformed",
  "header.malformed",
  "internal.error",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const TeamApplicationsSubmitCodes = [
  "request.malformed",
  "header.malformed",
  "idempotency-key.invalid",
  "resource.not-found",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "team-application.intake-closed",
  "transaction.conflict",
  "request.too-large",
  "media-type.unsupported",
  "validation.failed",
  "rate-limit.exceeded",
  "internal.error",
  "idempotency.unavailable",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const TeamApplicationsStaffReadCodes = [
  "request.malformed",
  "header.malformed",
  "authority.denied",
  "origin.denied",
  "resource.not-found",
  "internal.error",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const TeamApplicationsDeleteCodes = [
  "request.malformed",
  "header.malformed",
  "idempotency-key.invalid",
  "authority.denied",
  "origin.denied",
  "resource.not-found",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "idempotency.unavailable",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

export const TeamApplicationsReviseIntakeCodes = [
  "request.malformed",
  "header.malformed",
  "idempotency-key.invalid",
  "precondition.invalid",
  "authority.denied",
  "origin.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "precondition.failed",
  "request.too-large",
  "media-type.unsupported",
  "validation.failed",
  "validation.no-change",
  "validation.field-not-deletable",
  "precondition.required",
  "internal.error",
  "idempotency.unavailable",
] as const satisfies readonly [NativeProblemCode, ...NativeProblemCode[]];

type ResolverId = (typeof SCOPE_RESOLVER_IDS)[number];

/** Identity-bearing resolver symbols; an equal-looking object is not a trusted resolver. */
export const TeamApplicationsPublicIntakeResolver = {
  id: "team-applications.public-intake",
} as const satisfies { readonly id: ResolverId };

export const TeamApplicationsPublicIntakesResolver = {
  id: "team-applications.public-intakes",
} as const satisfies { readonly id: ResolverId };

export const TeamApplicationsCreateResolver = {
  id: "team-applications.application-create",
} as const satisfies { readonly id: ResolverId };

export const TeamApplicationsListResolver = {
  id: "team-applications.team-applications",
} as const satisfies { readonly id: ResolverId };

export const TeamApplicationsByIdResolver = {
  id: "team-applications.application-by-id",
} as const satisfies { readonly id: ResolverId };

export const TeamApplicationsIntakeByTeamResolver = {
  id: "team-applications.intake-by-team",
} as const satisfies { readonly id: ResolverId };

const publicPolicies = [
  { resolver: TeamApplicationsPublicIntakeResolver, decisionTime: "SnapshotRead" },
  { resolver: TeamApplicationsPublicIntakesResolver, decisionTime: "SnapshotRead" },
  { resolver: TeamApplicationsCreateResolver, decisionTime: "Transaction" },
] as const;

const staffPolicies = [
  {
    resolver: TeamApplicationsListResolver,
    capability: "team-applications.read",
    decisionTime: "SnapshotRead",
  },
  {
    resolver: TeamApplicationsByIdResolver,
    capability: "team-applications.read",
    decisionTime: "SnapshotRead",
  },
  {
    resolver: TeamApplicationsByIdResolver,
    capability: "team-applications.manage",
    decisionTime: "Transaction",
  },
  {
    resolver: TeamApplicationsIntakeByTeamResolver,
    capability: "team-applications.manage",
    decisionTime: "Transaction",
  },
] as const;

const resolverSymbol = <R extends { readonly id: ResolverId }>(symbol: R) =>
  Schema.declare((value: unknown): value is R => value === symbol);

const TeamApplicationsResolver = Schema.Union([
  resolverSymbol(TeamApplicationsPublicIntakeResolver),
  resolverSymbol(TeamApplicationsPublicIntakesResolver),
  resolverSymbol(TeamApplicationsCreateResolver),
  resolverSymbol(TeamApplicationsListResolver),
  resolverSymbol(TeamApplicationsByIdResolver),
  resolverSymbol(TeamApplicationsIntakeByTeamResolver),
]);

const TeamApplicationsAccess = Schema.Struct({
  exposure: Schema.Literal("External"),
  acceptedCredentials: Schema.Union([
    Schema.Tuple([Schema.Literal("None")]),
    Schema.Tuple([Schema.Literal("BetterAuthCookie"), Schema.Literal("OAuthUserBearer")]),
  ]),
  principalKinds: Schema.Union([
    Schema.Tuple([Schema.Literal("Anonymous")]),
    Schema.Tuple([Schema.Literal("Person")]),
  ]),
  capabilities: Schema.Union([
    Schema.TaggedStruct("None", {}),
    Schema.TaggedStruct("One", {
      capability: Schema.Literals(["team-applications.read", "team-applications.manage"]),
    }),
  ]),
  requirements: Schema.Array(Schema.Never),
  canonicalScopeResolver: TeamApplicationsResolver,
  concealment: Schema.TaggedStruct("Reveal", {}),
  decisionTime: Schema.Literals(["SnapshotRead", "Transaction"]),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (spec) => {
        const capabilities = spec.capabilities;

        return Predicate.isTagged(capabilities, "One")
          ? spec.acceptedCredentials.length === 2 &&
              spec.principalKinds[0] === "Person" &&
              staffPolicies.some(
                (policy) =>
                  policy.resolver === spec.canonicalScopeResolver &&
                  policy.capability === capabilities.capability &&
                  policy.decisionTime === spec.decisionTime,
              )
          : spec.acceptedCredentials.length === 1 &&
              spec.acceptedCredentials[0] === "None" &&
              spec.principalKinds[0] === "Anonymous" &&
              publicPolicies.some(
                (policy) =>
                  policy.resolver === spec.canonicalScopeResolver &&
                  policy.decisionTime === spec.decisionTime,
              );
      },
      { message: "one exact anonymous or Person TeamApplications AccessSpec" },
    ),
  ),
);

const decodeTeamApplicationsAccess = Schema.decodeUnknownSync(TeamApplicationsAccess, {
  onExcessProperty: "error",
});

/** Projects the seven declared contracts onto the existing native authority annotation. */
export const teamApplicationsAccessAnnotations = (input: HttpAccessAnnotationSpec) => {
  const spec = decodeTeamApplicationsAccess(input);

  return accessSpecAnnotations(
    Predicate.isTagged(spec.capabilities, "One")
      ? personNativeAccess({
          capability: spec.capabilities.capability,
          canonicalScopeResolver: spec.canonicalScopeResolver.id,
          decisionTime: spec.decisionTime,
        })
      : anonymousNativeAccess(spec.canonicalScopeResolver.id, spec.decisionTime),
  );
};
