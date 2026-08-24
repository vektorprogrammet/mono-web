import type { OrganizationAuthorityInstant } from "./authority.js";
import {
  type OrganizationAuthorityMembership,
  type OrganizationGlobalAdministratorStatus,
  type OrganizationPersonAuthority,
} from "./authority.js";
import { allow, deny, type Decision } from "../authz/decision.js";
import type { DepartmentId, PersonId } from "./schema.js";

/**
 * Spec 0057 directory facts for one person, derived from canonical
 * Organization state at the request's authorizationInstant.
 *
 * `isActive` follows the spec 0055 membership law exactly. The
 * global-administrator status travels beside the facts as its own field; it
 * never overrides `isActive` and never selects a primary department.
 */
export interface OrganizationDirectoryFact {
  /** Every distinct department reachable through resolvable memberships, sorted. */
  readonly departments: ReadonlyArray<DepartmentId>;
  /**
   * The display name of every department in `departments`, sorted by name.
   * The spec 0057 falsifier requires the frozen entry to carry department
   * NAMES (one row per person holding every department), so the derivation
   * resolves them beside the scope-law identifiers.
   */
  readonly departmentNames: ReadonlyArray<string>;
  readonly isActive: boolean;
  readonly globalAdministrator: OrganizationGlobalAdministratorStatus;
}

/** Person-keyed directory facts; one entry per requested person. */
export type OrganizationDirectoryFacts = ReadonlyMap<PersonId, OrganizationDirectoryFact>;

/**
 * Accumulates decoded membership and global-administrator grant rows into the
 * per-person directory facts. Pure and table-tested; the PostgreSQL
 * interpreter only decodes rows and delegates here.
 *
 * Detached memberships (no resolvable team row) never reach this accumulator:
 * their rows drop out of the interpreter's inner join and contribute neither a
 * department nor activity.
 */
export const accumulateOrganizationDirectoryFacts = (input: {
  readonly personIds: ReadonlyArray<PersonId>;
  readonly instant: OrganizationAuthorityInstant;
  readonly memberships: ReadonlyArray<{
    readonly personId: PersonId;
    readonly departmentId: DepartmentId;
    /** Canonical display name of the membership's department. */
    readonly departmentName?: string | undefined;
    readonly active: boolean;
  }>;
  readonly grants: ReadonlyArray<{
    readonly personId: PersonId;
    readonly globalAdministrator: OrganizationGlobalAdministratorStatus;
  }>;
}): OrganizationDirectoryFacts => {
  const facts = new Map<
    PersonId,
    {
      departments: Set<DepartmentId>;
      namesByDepartment: Map<DepartmentId, string>;
      isActive: boolean;
    }
  >();
  for (const personId of input.personIds) {
    facts.set(personId, {
      departments: new Set(),
      namesByDepartment: new Map(),
      isActive: false,
    });
  }
  for (const membership of input.memberships) {
    const fact = facts.get(membership.personId);
    if (fact === undefined) continue;
    fact.departments.add(membership.departmentId);
    if (membership.departmentName !== undefined) {
      fact.namesByDepartment.set(membership.departmentId, membership.departmentName);
    }
    if (membership.active) fact.isActive = true;
  }
  const grantsByPerson = new Map<PersonId, OrganizationGlobalAdministratorStatus>();
  for (const grant of input.grants) grantsByPerson.set(grant.personId, grant.globalAdministrator);
  const result = new Map<PersonId, OrganizationDirectoryFact>();
  for (const [personId, fact] of facts) {
    result.set(personId, {
      departments: [...fact.departments].sort((left, right) => left.localeCompare(right)),
      departmentNames: [...fact.namesByDepartment.values()].sort((left, right) =>
        left.localeCompare(right),
      ),
      isActive: fact.isActive,
      globalAdministrator: grantsByPerson.get(personId) ?? "Absent",
    });
  }
  return result;
};

/**
 * The authorized view of the whole directory (spec 0057 §Gating). An active
 * global administrator reads all departments; otherwise the union of
 * active-leader departments forms the scope. A list query evaluates the whole
 * authorized scope and never selects one membership and discards the others.
 */
export type DirectoryGateScope =
  | { readonly _tag: "AllDepartments" }
  | { readonly _tag: "Departments"; readonly departmentIds: ReadonlyArray<DepartmentId> };

/**
 * Maps the caller projection onto the directory gate (spec 0057 §Gating
 * table). Memberships that exist but carry no active leadership, and ended
 * grants, deny with `AuthorityInactive`; a person with no Organization
 * authority record at all denies with `NotInScope`.
 */
export const resolveDirectoryGateScope = (
  authority: OrganizationPersonAuthority,
): Decision<DirectoryGateScope> => {
  if (authority.globalAdministrator === "Active") {
    return allow<DirectoryGateScope>({ _tag: "AllDepartments" });
  }
  const departmentIds = [
    ...new Set(
      authority.memberships
        .filter((membership) => membership.active && membership.teamLeader)
        .map((membership: OrganizationAuthorityMembership) => membership.departmentId),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (departmentIds.length > 0) {
    return allow<DirectoryGateScope>({ _tag: "Departments", departmentIds });
  }
  return deny<DirectoryGateScope>(
    authority.memberships.length > 0 || authority.globalAdministrator === "Inactive"
      ? "AuthorityInactive"
      : "NotInScope",
  );
};

/**
 * Whether one row's derived departments intersect the authorized scope. An
 * empty intersection is a legitimate empty view, never a denial.
 */
export const directoryRowInScope = (
  scope: DirectoryGateScope,
  departments: ReadonlyArray<DepartmentId>,
): boolean => {
  if (scope._tag === "AllDepartments") return true;
  return departments.some((departmentId) => scope.departmentIds.includes(departmentId));
};
