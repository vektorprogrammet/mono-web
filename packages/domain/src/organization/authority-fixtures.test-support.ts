import { Result } from "effect";
import type { OrganizationCapability } from "../authz/delegation.js";
import { requireDepartmentReach, type DepartmentReach } from "../authz/reach.js";
import type { OrganizationPersonAuthority } from "./authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "./schema.js";
import { dual } from "effect/Function";

export interface Spec0055OrganizationAuthorityFixtureIds {
  readonly evaluatedAt: string;
  readonly departmentId: string;
  readonly teamId: string;
  readonly persons: {
    readonly administrator: string;
    readonly leader: string;
    readonly inactiveLeader: string;
    readonly member: string;
    readonly absent: string;
  };
  readonly memberships: {
    readonly leader: string;
    readonly inactiveLeader: string;
    readonly member: string;
  };
}

export interface Spec0055OrganizationAuthorityFixtures {
  readonly administrator: OrganizationPersonAuthority;
  readonly leader: OrganizationPersonAuthority;
  readonly inactiveLeader: OrganizationPersonAuthority;
  readonly member: OrganizationPersonAuthority;
  readonly absent: OrganizationPersonAuthority;
}

/**
 * Shared accepted/rejected fixtures from the spec 0055 mapper truth table. The team is its
 * independent department's board (Styret): only a board's leader reaches the department.
 */
export const spec0055OrganizationAuthorityFixtures = (
  ids: Spec0055OrganizationAuthorityFixtureIds,
): Spec0055OrganizationAuthorityFixtures => {
  const departmentId = DepartmentId.make(ids.departmentId);
  const teamId = TeamId.make(ids.teamId);

  const board = {
    unitKind: "DepartmentBoard",
    teamScope: "HomeDepartment",
    departmentIndependent: true,
  } as const;

  return {
    administrator: {
      personId: PersonId.make(ids.persons.administrator),
      evaluatedAt: ids.evaluatedAt,
      globalAdministrator: "Active",
      memberships: [],
      nationalBoardSeats: [],
      delegations: [],
    },
    leader: {
      personId: PersonId.make(ids.persons.leader),
      evaluatedAt: ids.evaluatedAt,
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: MembershipId.make(ids.memberships.leader),
          teamId,
          departmentId,
          active: true,
          unitLeader: true,
          ...board,
        },
      ],
      nationalBoardSeats: [],
      delegations: [],
    },
    inactiveLeader: {
      personId: PersonId.make(ids.persons.inactiveLeader),
      evaluatedAt: ids.evaluatedAt,
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: MembershipId.make(ids.memberships.inactiveLeader),
          teamId,
          departmentId,
          active: false,
          unitLeader: true,
          ...board,
        },
      ],
      nationalBoardSeats: [],
      delegations: [],
    },
    member: {
      personId: PersonId.make(ids.persons.member),
      evaluatedAt: ids.evaluatedAt,
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: MembershipId.make(ids.memberships.member),
          teamId,
          departmentId,
          active: true,
          unitLeader: false,
          ...board,
        },
      ],
      nationalBoardSeats: [],
      delegations: [],
    },
    absent: {
      personId: PersonId.make(ids.persons.absent),
      evaluatedAt: ids.evaluatedAt,
      globalAdministrator: "Absent",
      memberships: [],
      nationalBoardSeats: [],
      delegations: [],
    },
  };
};

/**
 * The resolved authority of an active global administrator with no appointments, at a fixed
 * instant. Tests and proofs mint evidence from it; production resolves authority from facts.
 */
export const activeAdministratorAuthority = (personId: string): OrganizationPersonAuthority => ({
  personId: PersonId.make(personId),
  evaluatedAt: "2026-09-28T12:00:00.000Z",
  globalAdministrator: "Active",
  memberships: [],
  nationalBoardSeats: [],
  delegations: [],
});

/**
 * Department reach evidence for an active global administrator, for tests and proofs that call a
 * department-scoped command directly. A capability that no global administrator holds fails.
 */
export const administratorDepartmentReach: {
  <C extends OrganizationCapability>(
    capability: C,
    departmentId: string,
  ): (personId: string) => DepartmentReach<C>;
  <C extends OrganizationCapability>(
    personId: string,
    capability: C,
    departmentId: string,
  ): DepartmentReach<C>;
} = dual(
  3,
  <C extends OrganizationCapability>(
    personId: string,
    capability: C,
    departmentId: string,
  ): DepartmentReach<C> =>
    Result.getOrThrow(
      requireDepartmentReach(
        activeAdministratorAuthority(personId),
        capability,
        DepartmentId.make(departmentId),
      ),
    ),
);
