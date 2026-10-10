import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import { type SCOPE_RESOLVER_IDS } from "@vektorprogrammet/domain/authz";
import { Predicate, Schema } from "effect";
import { accessSpecAnnotations, anonymousNativeAccess, personNativeAccess } from "./access.js";
import { decodeDeclaredOrThrow } from "./declaration-decoding.js";

/** The exported identities bind the declared resolver to its current authority projection. */
export const OrganizationPublicDepartmentsResolver = {
  id: "organization.public-departments",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const OrganizationPublicTeamsResolver = {
  id: "organization.public-teams",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const OrganizationPublicFieldOfStudiesResolver = {
  id: "organization.public-field-of-studies",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const OrganizationTeamInterestResolver = {
  id: "organization.team-interest-registrations",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const OrganizationMailingListsResolver = {
  id: "organization.mailing-lists",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const OrganizationDepartmentCreateResolver = {
  id: "organization.department-create",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const OrganizationTeamCreateResolver = {
  id: "organization.team-create",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const OrganizationFieldOfStudyCreateResolver = {
  id: "organization.field-of-study-create",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const OrganizationAppointmentManagementResolver = {
  id: "organization.appointment-management",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

export const OrganizationDelegationManagementResolver = {
  id: "organization.delegation-management",
} as const satisfies { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] };

const publicResolvers = [
  OrganizationPublicDepartmentsResolver,
  OrganizationPublicTeamsResolver,
  OrganizationPublicFieldOfStudiesResolver,
] as const;

const staffPolicies = [
  {
    resolver: OrganizationTeamInterestResolver,
    capability: "organization.read-team-interest",
    decisionTime: "SnapshotRead",
  },
  {
    resolver: OrganizationMailingListsResolver,
    capability: "organization.read-mailing-lists",
    decisionTime: "SnapshotRead",
  },
  {
    resolver: OrganizationDepartmentCreateResolver,
    capability: "organization.create-department",
    decisionTime: "Transaction",
  },
  {
    resolver: OrganizationTeamCreateResolver,
    capability: "organization.create-team",
    decisionTime: "Transaction",
  },
  {
    resolver: OrganizationFieldOfStudyCreateResolver,
    capability: "organization.create-field-of-study",
    decisionTime: "Transaction",
  },
  {
    resolver: OrganizationAppointmentManagementResolver,
    capability: "organization.manage-appointments",
    decisionTime: "SnapshotRead",
  },
  {
    resolver: OrganizationAppointmentManagementResolver,
    capability: "organization.manage-appointments",
    decisionTime: "Transaction",
  },
  {
    resolver: OrganizationDelegationManagementResolver,
    capability: "organization.manage-delegations",
    decisionTime: "SnapshotRead",
  },
  {
    resolver: OrganizationDelegationManagementResolver,
    capability: "organization.manage-delegations",
    decisionTime: "Transaction",
  },
] as const;

const resolverSymbol = <R extends { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] }>(
  symbol: R,
) => Schema.declare((value: unknown): value is R => value === symbol);

const OrganizationResolver = Schema.Union([
  ...publicResolvers.map(resolverSymbol),
  resolverSymbol(OrganizationTeamInterestResolver),
  resolverSymbol(OrganizationMailingListsResolver),
  resolverSymbol(OrganizationDepartmentCreateResolver),
  resolverSymbol(OrganizationTeamCreateResolver),
  resolverSymbol(OrganizationFieldOfStudyCreateResolver),
  resolverSymbol(OrganizationAppointmentManagementResolver),
  resolverSymbol(OrganizationDelegationManagementResolver),
]);

const OrganizationAccess = Schema.Struct({
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
      capability: Schema.Literals(staffPolicies.map((policy) => policy.capability)),
    }),
  ]),
  requirements: Schema.Array(Schema.Never),
  canonicalScopeResolver: OrganizationResolver,
  concealment: Schema.TaggedStruct("Reveal", {}),
  decisionTime: Schema.Literals(["SnapshotRead", "Transaction"]),
}).pipe(
  Schema.check(
    Schema.makeFilter((spec) => {
      const capabilities = spec.capabilities;

      if (Predicate.isTagged(capabilities, "One")) {
        return (
          spec.acceptedCredentials.length === 2 &&
          spec.principalKinds[0] === "Person" &&
          staffPolicies.some(
            (policy) =>
              policy.resolver === spec.canonicalScopeResolver &&
              policy.capability === capabilities.capability &&
              policy.decisionTime === spec.decisionTime,
          )
        );
      }

      return (
        spec.acceptedCredentials.length === 1 &&
        spec.acceptedCredentials[0] === "None" &&
        spec.principalKinds[0] === "Anonymous" &&
        spec.decisionTime === "SnapshotRead" &&
        publicResolvers.some((resolver) => resolver === spec.canonicalScopeResolver)
      );
    }),
  ),
);

const decodeOrganizationAccess = decodeDeclaredOrThrow(OrganizationAccess, {
  onExcessProperty: "error",
});

/** Projects only the thirteen approved operations onto the existing native AccessSpec. */
export const organizationAccessAnnotations = (input: HttpAccessAnnotationSpec) => {
  const spec = decodeOrganizationAccess(input);

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
