import { Array, Data, Predicate, Result } from "effect";
import { dual } from "effect/Function";
import {
  PrincipalSchema,
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
  Scope,
  decodeGrant,
} from "../authz/access.js";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import type { DepartmentId, PersonId } from "../organization/schema.js";

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
export const socialEventDepartmentAccessContext: {
  (
    departmentId: DepartmentId,
  ): (authority: OrganizationPersonAuthority) => CanonicalResourceContext<Record<string, never>>;
  (
    authority: OrganizationPersonAuthority,
    departmentId: DepartmentId,
  ): CanonicalResourceContext<Record<string, never>>;
} = dual(
  2,
  (
    authority: OrganizationPersonAuthority,
    departmentId: DepartmentId,
  ): CanonicalResourceContext<Record<string, never>> => ({
    domainId: SOCIAL_EVENTS_DOMAIN_ID,
    departmentId,
    resource: null,
    facts: {},
    authorityVersion: authorityVersion(authority),
  }),
);

const scopeIdentity = (scope: Scope): string => JSON.stringify(scope);

const grantIdentity = (capability: CapabilityTypeId, scope: Scope): string =>
  `${capability}:${scopeIdentity(scope)}`;

const generatedGrantId = (
  authority: OrganizationPersonAuthority,
  capability: CapabilityTypeId,
  scope: Scope,
): string => `social-events:${authority.personId}:${capability}:${scopeIdentity(scope)}`;

/**
 * Derives all and only social-event candidate grants from one complete
 * Organization authority projection. Inactive facts contribute nothing.
 */
export const deriveSocialEventCandidateGrants = (
  authority: OrganizationPersonAuthority,
): ReadonlyArray<Grant> => {
  const candidates: Array<readonly [CapabilityTypeId, Scope]> = [];
  const domainScope: Scope = Scope.Domain({ domainId: SOCIAL_EVENTS_DOMAIN_ID });

  if (authority.globalAdministrator === "Active") {
    candidates.push(
      [SOCIAL_EVENTS_READ_SCOPE_CAPABILITY, domainScope],
      [SOCIAL_EVENTS_READ_CAPABILITY, Scope.Global()],
      [SOCIAL_EVENTS_CREATE_CAPABILITY, Scope.Global()],
    );
  }

  const activeDepartmentIds = [
    ...new Set(
      Array.filterMap(authority.memberships, (membership) =>
        membership.active ? Result.succeed(membership.departmentId) : Result.failVoid,
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));

  for (const departmentId of activeDepartmentIds) {
    const departmentScope: Scope = Scope.Department({ departmentId });
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
      decodeGrant({
        grantId: GrantId.make(generatedGrantId(authority, capability, scope)),
        subject: PrincipalSchema.cases.Person.make({ personId: authority.personId }),
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
export const socialEventCandidateGrantScopes: {
  (capability: CapabilityTypeId): (authority: OrganizationPersonAuthority) => ReadonlyArray<Scope>;
  (authority: OrganizationPersonAuthority, capability: CapabilityTypeId): ReadonlyArray<Scope>;
} = dual(
  2,
  (authority: OrganizationPersonAuthority, capability: CapabilityTypeId): ReadonlyArray<Scope> =>
    Array.filterMap(deriveSocialEventCandidateGrants(authority), (grant) =>
      grant.capability.type === capability ? Result.succeed(grant.scope) : Result.failVoid,
    ),
);

/** Type-only brand. Only {@link requireSocialEventCreation} builds this evidence. */
declare const SocialEventCreationBrand: unique symbol;

/** Proof that a person may create a social event in one department at the authority's instant. */
export interface SocialEventCreation {
  readonly [SocialEventCreationBrand]: "SocialEventCreation";
  readonly personId: PersonId;
  readonly departmentId: DepartmentId;
}

/** The person holds no create grant that covers the department. */
export class SocialEventCreationDenied extends Data.TaggedError("SocialEventCreationDenied")<{
  readonly personId: PersonId;
  readonly departmentId: DepartmentId;
}> {}

/**
 * Checks that a resolved authority may create a social event in one department, and returns the
 * evidence that creation requires.
 *
 * @remarks
 * It is the only constructor of {@link SocialEventCreation} and decides with the candidate grants
 * that the create AccessSpec evaluates: an active global administrator creates everywhere, and an
 * active appointment in the department creates there.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const creator = yield* Effect.fromResult(requireSocialEventCreation(authority, departmentId));
 * yield* events.create(creator, { commandId, occurredAt, eventId, request });
 * ```
 *
 * @avoid Passing the creator's person id to `create`: the command then trusts that some caller
 * checked the department. Require the evidence, which names the department it covers.
 */
export const requireSocialEventCreation: {
  (
    /** The department of the event. */
    departmentId: DepartmentId,
  ): (
    /** The person's authority, resolved from current facts inside the command transaction. */
    authority: OrganizationPersonAuthority,
  ) => /** Evidence for the department, or the typed denial. */
  Result.Result<SocialEventCreation, SocialEventCreationDenied>;
  (
    /** The person's authority, resolved from current facts inside the command transaction. */
    authority: OrganizationPersonAuthority,
    /** The department of the event. */
    departmentId: DepartmentId,
  ): /** Evidence for the department, or the typed denial. */
  Result.Result<SocialEventCreation, SocialEventCreationDenied>;
} = dual(
  2,
  (
    /** The person's authority, resolved from current facts inside the command transaction. */
    authority: OrganizationPersonAuthority,
    /** The department of the event. */
    departmentId: DepartmentId,
  ): /** Evidence for the department, or the typed denial. */
  Result.Result<SocialEventCreation, SocialEventCreationDenied> =>
    socialEventCandidateGrantScopes(authority, SOCIAL_EVENTS_CREATE_CAPABILITY).some(
      (scope) =>
        Predicate.isTagged(scope, "Global") ||
        (Predicate.isTagged(scope, "Department") && scope.departmentId === departmentId),
    )
      ? Result.succeed(
          // SAFETY: the one constructor of the evidence brand; the grant check above is what it proves.
          { personId: authority.personId, departmentId } as SocialEventCreation,
        )
      : Result.fail(new SocialEventCreationDenied({ personId: authority.personId, departmentId })),
);
