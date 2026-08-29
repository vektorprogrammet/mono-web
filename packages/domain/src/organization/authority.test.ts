import { expect, it } from "@effect/vitest";
import {
  mapOrganizationAuthorityToAdmissionPeriodActor,
  mapOrganizationAuthorityToRecruitmentActor,
  mapOrganizationAuthorityToOrganizationActor,
  mapOrganizationAuthorityToProfileRole,
  type OrganizationAuthorityMembership,
  type OrganizationGlobalAdministratorStatus,
  type OrganizationPersonAuthority,
} from "./authority.js";
import { makeSpec0055OrganizationAuthorityFixtures } from "./authority-fixtures.test-support.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "./schema.js";

const evaluatedAt = "2026-08-24T12:00:00.000Z";
const personId = PersonId.make("authority-person");
const departmentA = DepartmentId.make("department-a");
const departmentB = DepartmentId.make("department-b");
const departmentC = DepartmentId.make("department-c");

const membership = (
  membershipId: string,
  teamId: string,
  departmentId: DepartmentId,
  active: boolean,
  teamLeader: boolean,
): OrganizationAuthorityMembership => ({
  membershipId: MembershipId.make(membershipId),
  teamId: TeamId.make(teamId),
  departmentId,
  active,
  teamLeader,
});

const authority = (
  globalAdministrator: OrganizationGlobalAdministratorStatus,
  memberships: ReadonlyArray<OrganizationAuthorityMembership>,
): OrganizationPersonAuthority => ({
  personId,
  evaluatedAt,
  globalAdministrator,
  memberships,
});

it("maps every requested department without selecting a primary department", () => {
  const projection = authority("Absent", [
    membership("membership-a", "team-a", departmentA, true, false),
    membership("membership-b", "team-b", departmentB, true, true),
  ]);

  expect(mapOrganizationAuthorityToAdmissionPeriodActor(projection, departmentA)).toEqual({
    _tag: "Allow",
    value: {
      _tag: "Member",
      personId,
      departmentId: departmentA,
      active: true,
    },
  });
  expect(mapOrganizationAuthorityToAdmissionPeriodActor(projection, departmentB)).toEqual({
    _tag: "Allow",
    value: {
      _tag: "DepartmentLeader",
      personId,
      departmentId: departmentB,
      active: true,
    },
  });
  expect(mapOrganizationAuthorityToRecruitmentActor(projection, departmentB)).toEqual({
    _tag: "Allow",
    value: {
      _tag: "DepartmentLeader",
      personId,
      departmentId: departmentB,
      active: true,
    },
  });
  expect(mapOrganizationAuthorityToAdmissionPeriodActor(projection, departmentC)).toEqual({
    _tag: "Deny",
    reason: "NotInScope",
  });
  expect(mapOrganizationAuthorityToRecruitmentActor(projection, departmentC)).toEqual({
    _tag: "Deny",
    reason: "NotInScope",
  });
  expect(projection.memberships.map(({ departmentId }) => departmentId)).toEqual([
    departmentA,
    departmentB,
  ]);
});

it("applies global-administrator and department role precedence", () => {
  const globalAdministrator = authority("Active", [
    membership("membership-admin", "team-admin", departmentA, true, true),
  ]);
  expect(mapOrganizationAuthorityToAdmissionPeriodActor(globalAdministrator, departmentA)).toEqual({
    _tag: "Allow",
    value: { _tag: "GlobalAdmin", personId, active: true },
  });
  expect(mapOrganizationAuthorityToOrganizationActor(globalAdministrator)).toEqual({
    _tag: "OrganizationAdministrator",
    personId,
  });
  expect(mapOrganizationAuthorityToProfileRole(globalAdministrator)).toEqual({
    _tag: "Allow",
    value: "ROLE_ADMIN",
  });

  const activeMemberAndInactiveLeader = authority("Absent", [
    membership("membership-member", "team-member", departmentA, true, false),
    membership("membership-old-leader", "team-old-leader", departmentA, false, true),
  ]);
  expect(
    mapOrganizationAuthorityToAdmissionPeriodActor(activeMemberAndInactiveLeader, departmentA),
  ).toEqual({
    _tag: "Allow",
    value: { _tag: "Member", personId, departmentId: departmentA, active: true },
  });
  expect(mapOrganizationAuthorityToProfileRole(activeMemberAndInactiveLeader)).toEqual({
    _tag: "Allow",
    value: "ROLE_TEAM_MEMBER",
  });
});

it("denies inactive chosen authority with its reason at the mapper boundary", () => {
  const inactiveAdministrator = authority("Inactive", [
    membership("membership-current-leader", "team-current", departmentA, true, true),
  ]);
  expect(
    mapOrganizationAuthorityToAdmissionPeriodActor(inactiveAdministrator, departmentA),
  ).toEqual({ _tag: "Deny", reason: "AuthorityInactive" });
  expect(mapOrganizationAuthorityToOrganizationActor(inactiveAdministrator)).toEqual({
    _tag: "OrganizationMember",
    personId,
  });
  expect(mapOrganizationAuthorityToProfileRole(inactiveAdministrator)).toEqual({
    _tag: "Allow",
    value: "ROLE_TEAM_LEADER",
  });

  const inactiveLeader = authority("Absent", [
    membership("membership-inactive-leader", "team-inactive", departmentB, false, true),
  ]);
  expect(mapOrganizationAuthorityToAdmissionPeriodActor(inactiveLeader, departmentB)).toEqual({
    _tag: "Deny",
    reason: "AuthorityInactive",
  });
  expect(mapOrganizationAuthorityToRecruitmentActor(inactiveLeader, departmentB)).toEqual({
    _tag: "Deny",
    reason: "AuthorityInactive",
  });
  expect(mapOrganizationAuthorityToProfileRole(inactiveLeader)).toEqual({
    _tag: "Deny",
    reason: "AuthorityInactive",
  });

  const inactiveMember = authority("Absent", [
    membership("membership-inactive-member", "team-inactive-member", departmentA, false, false),
  ]);
  expect(mapOrganizationAuthorityToAdmissionPeriodActor(inactiveMember, departmentA)).toEqual({
    _tag: "Deny",
    reason: "AuthorityInactive",
  });
});

it("distinguishes Profile absence from known inactive authority", () => {
  expect(mapOrganizationAuthorityToProfileRole(authority("Absent", []))).toEqual({
    _tag: "Deny",
    reason: "NotInScope",
  });
  expect(mapOrganizationAuthorityToProfileRole(authority("Inactive", []))).toEqual({
    _tag: "Deny",
    reason: "AuthorityInactive",
  });
  expect(
    mapOrganizationAuthorityToProfileRole(
      authority("Absent", [
        membership("membership-history", "team-history", departmentA, false, false),
      ]),
    ),
  ).toEqual({
    _tag: "Deny",
    reason: "AuthorityInactive",
  });
});

it("uses leader before member for active Profile authority across departments", () => {
  const projection = authority("Absent", [
    membership("membership-member-a", "team-member-a", departmentA, true, false),
    membership("membership-leader-b", "team-leader-b", departmentB, true, true),
  ]);

  expect(mapOrganizationAuthorityToProfileRole(projection)).toEqual({
    _tag: "Allow",
    value: "ROLE_TEAM_LEADER",
  });
  expect(mapOrganizationAuthorityToOrganizationActor(projection)).toEqual({
    _tag: "OrganizationMember",
    personId,
  });
});

it("shares the frozen spec0055 accepted and rejected fixtures with PostgreSQL proof", () => {
  const fixtures = makeSpec0055OrganizationAuthorityFixtures({
    evaluatedAt,
    departmentId: departmentA,
    teamId: "team-shared-fixture",
    persons: {
      administrator: "authority-shared-administrator",
      leader: "authority-shared-leader",
      inactiveLeader: "authority-shared-inactive-leader",
      member: "authority-shared-member",
      absent: "authority-shared-absent",
    },
    memberships: {
      leader: "membership-shared-leader",
      inactiveLeader: "membership-shared-inactive-leader",
      member: "membership-shared-member",
    },
  });

  expect(mapOrganizationAuthorityToAdmissionPeriodActor(fixtures.leader, departmentA)._tag).toBe(
    "Allow",
  );
  expect(mapOrganizationAuthorityToRecruitmentActor(fixtures.inactiveLeader, departmentA)).toEqual({
    _tag: "Deny",
    reason: "AuthorityInactive",
  });
  expect(mapOrganizationAuthorityToOrganizationActor(fixtures.administrator)._tag).toBe(
    "OrganizationAdministrator",
  );
  expect(mapOrganizationAuthorityToOrganizationActor(fixtures.member)._tag).toBe(
    "OrganizationMember",
  );
  expect(mapOrganizationAuthorityToProfileRole(fixtures.absent)).toEqual({
    _tag: "Deny",
    reason: "NotInScope",
  });
});
