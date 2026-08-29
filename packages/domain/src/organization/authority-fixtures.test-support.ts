import type { OrganizationPersonAuthority } from "./authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "./schema.js";

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

/** Shared accepted/rejected fixtures from the frozen spec 0055 mapper truth table. */
export const makeSpec0055OrganizationAuthorityFixtures = (
  ids: Spec0055OrganizationAuthorityFixtureIds,
): Spec0055OrganizationAuthorityFixtures => {
  const departmentId = DepartmentId.make(ids.departmentId);
  const teamId = TeamId.make(ids.teamId);
  return {
    administrator: {
      personId: PersonId.make(ids.persons.administrator),
      evaluatedAt: ids.evaluatedAt,
      globalAdministrator: "Active",
      memberships: [],
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
          teamLeader: true,
        },
      ],
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
          teamLeader: true,
        },
      ],
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
          teamLeader: false,
        },
      ],
    },
    absent: {
      personId: PersonId.make(ids.persons.absent),
      evaluatedAt: ids.evaluatedAt,
      globalAdministrator: "Absent",
      memberships: [],
    },
  };
};
