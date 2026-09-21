import {
  AuthorityRef,
  AuthorityVersion,
  GrantId,
  SOCIAL_EVENTS_CREATE_CAPABILITY,
  SOCIAL_EVENTS_DOMAIN_ID,
  SOCIAL_EVENTS_READ_CAPABILITY,
  SOCIAL_EVENTS_READ_SCOPE_CAPABILITY,
  type CanonicalResourceContext,
  type CapabilityTypeId,
  type Grant,
  type Scope,
  makeGrant,
} from "../authz/access.js";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import type { DepartmentId } from "../organization/schema.js";

const authorityVersion = (authority: OrganizationPersonAuthority) =>
  AuthorityVersion.make(`organization:${authority.evaluatedAt}`);

/** Canonical resolver context for `social-events.scope`. */
export const socialEventScopeAccessContext = (
  authority: OrganizationPersonAuthority,
): CanonicalResourceContext<Record<string, never>> => ({
  domainId: SOCIAL_EVENTS_DOMAIN_ID,
  departmentId: null,
  resource: null,
  facts: {},
  authorityVersion: authorityVersion(authority),
});

/** Canonical resolver context shared by `social-events.list` and `.create`. */
export const socialEventDepartmentAccessContext = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): CanonicalResourceContext<Record<string, never>> => ({
  domainId: SOCIAL_EVENTS_DOMAIN_ID,
  departmentId,
  resource: null,
  facts: {},
  authorityVersion: authorityVersion(authority),
});

const scopeIdentity = (scope: Scope): string => JSON.stringify(scope);
const grantIdentity = (capability: CapabilityTypeId, scope: Scope): string =>
  `${capability}:${scopeIdentity(scope)}`;
const generatedGrantId = (
  authority: OrganizationPersonAuthority,
  capability: CapabilityTypeId,
  scope: Scope,
): string =>
  `social-events:${authority.personId}:${capability}:${scopeIdentity(scope)}`;

/**
 * Derives all and only social-event candidate grants from one complete
 * Organization authority projection. Inactive facts contribute nothing.
 */
export const deriveSocialEventCandidateGrants = (
  authority: OrganizationPersonAuthority,
): ReadonlyArray<Grant> => {
  const candidates: Array<readonly [CapabilityTypeId, Scope]> = [];
  const domainScope: Scope = { _tag: "Domain", domainId: SOCIAL_EVENTS_DOMAIN_ID };

  if (authority.globalAdministrator === "Active") {
    candidates.push(
      [SOCIAL_EVENTS_READ_SCOPE_CAPABILITY, domainScope],
      [SOCIAL_EVENTS_READ_CAPABILITY, { _tag: "Global" }],
      [SOCIAL_EVENTS_CREATE_CAPABILITY, { _tag: "Global" }],
    );
  }

  const activeDepartmentIds = [
    ...new Set(
      authority.memberships
        .filter((membership) => membership.active)
        .map((membership) => membership.departmentId),
    ),
  ].sort((left, right) => left.localeCompare(right));
  for (const departmentId of activeDepartmentIds) {
    const departmentScope: Scope = { _tag: "Department", departmentId };
    candidates.push(
      [SOCIAL_EVENTS_READ_SCOPE_CAPABILITY, domainScope],
      [SOCIAL_EVENTS_READ_CAPABILITY, departmentScope],
      [SOCIAL_EVENTS_CREATE_CAPABILITY, departmentScope],
    );
  }

  const grants = new Map<string, Grant>();
  for (const [capability, scope] of candidates) {
    const identity = grantIdentity(capability, scope);
    if (grants.has(identity)) continue;
    grants.set(
      identity,
      makeGrant({
        grantId: GrantId.make(generatedGrantId(authority, capability, scope)),
        subject: { _tag: "Person", personId: authority.personId },
        capability: { type: capability },
        scope,
        startAt: authority.evaluatedAt,
        endAt: null,
        requirements: [],
        source: AuthorityRef.make("organization-person-authority"),
        revision: 0,
      }),
    );
  }
  return [...grants.values()];
};

/**
 * Exact capability-specific scope candidates for the generic native access
 * evaluator. Keeping capability selection here prevents a department fact
 * from becoming a grant for an unrelated social-event operation.
 */
export const socialEventCandidateGrantScopes = (
  authority: OrganizationPersonAuthority,
  capability: CapabilityTypeId,
): ReadonlyArray<Scope> =>
  deriveSocialEventCandidateGrants(authority)
    .filter((grant) => grant.capability.type === capability)
    .map((grant) => grant.scope);
