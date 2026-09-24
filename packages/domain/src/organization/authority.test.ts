import {
  OrganizationMemberSchema,
  OrganizationAdministratorSchema,
} from "./administration-schema.js";
import { deny, allow } from "../authz/decision.js";
import { AdmissionPeriodActorSchema } from "../admission-period/schema.js";
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
import { spec0055OrganizationAuthorityFixtures } from "./authority-fixtures.test-support.js";
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

  expect(mapOrganizationAuthorityToAdmissionPeriodActor(projection, departmentA)).toEqual(
    allow(
      AdmissionPeriodActorSchema.cases.Member.make({
        personId,
        departmentId: departmentA,
        active: true,
      }),
    ),
  );
  expect(mapOrganizationAuthorityToAdmissionPeriodActor(projection, departmentB)).toEqual(
    allow(
      AdmissionPeriodActorSchema.cases.DepartmentLeader.make({
        personId,
        departmentId: departmentB,
        active: true,
      }),
    ),
  );
  expect(mapOrganizationAuthorityToRecruitmentActor(projection, departmentB)).toEqual(
    allow(
      AdmissionPeriodActorSchema.cases.DepartmentLeader.make({
        personId,
        departmentId: departmentB,
        active: true,
      }),
    ),
  );
  expect(mapOrganizationAuthorityToAdmissionPeriodActor(projection, departmentC)).toEqual(
    deny("NotInScope"),
  );
  expect(mapOrganizationAuthorityToRecruitmentActor(projection, departmentC)).toEqual(
    deny("NotInScope"),
  );
  expect(projection.memberships.map(({ departmentId }) => departmentId)).toEqual([
    departmentA,
    departmentB,
  ]);
});

it("applies global-administrator and department role precedence", () => {
  const globalAdministrator = authority("Active", [
    membership("membership-admin", "team-admin", departmentA, true, true),
  ]);

  expect(mapOrganizationAuthorityToAdmissionPeriodActor(globalAdministrator, departmentA)).toEqual(
    allow(AdmissionPeriodActorSchema.cases.GlobalAdmin.make({ personId, active: true })),
  );
  expect(mapOrganizationAuthorityToOrganizationActor(globalAdministrator)).toEqual(
    OrganizationAdministratorSchema.make({ personId }),
  );
  expect(mapOrganizationAuthorityToProfileRole(globalAdministrator)).toEqual(allow("ROLE_ADMIN"));

  const activeMemberAndInactiveLeader = authority("Absent", [
    membership("membership-member", "team-member", departmentA, true, false),
    membership("membership-old-leader", "team-old-leader", departmentA, false, true),
  ]);

  expect(
    mapOrganizationAuthorityToAdmissionPeriodActor(activeMemberAndInactiveLeader, departmentA),
  ).toEqual(
    allow(
      AdmissionPeriodActorSchema.cases.Member.make({
        personId,
        departmentId: departmentA,
        active: true,
      }),
    ),
  );
  expect(mapOrganizationAuthorityToProfileRole(activeMemberAndInactiveLeader)).toEqual(
    allow("ROLE_TEAM_MEMBER"),
  );
});

it("denies inactive chosen authority with its reason at the mapper boundary", () => {
  const inactiveAdministrator = authority("Inactive", [
    membership("membership-current-leader", "team-current", departmentA, true, true),
  ]);

  expect(
    mapOrganizationAuthorityToAdmissionPeriodActor(inactiveAdministrator, departmentA),
  ).toEqual(deny("AuthorityInactive"));
  expect(mapOrganizationAuthorityToOrganizationActor(inactiveAdministrator)).toEqual(
    OrganizationMemberSchema.make({ personId }),
  );
  expect(mapOrganizationAuthorityToProfileRole(inactiveAdministrator)).toEqual(
    allow("ROLE_TEAM_LEADER"),
  );

  const inactiveLeader = authority("Absent", [
    membership("membership-inactive-leader", "team-inactive", departmentB, false, true),
  ]);

  expect(mapOrganizationAuthorityToAdmissionPeriodActor(inactiveLeader, departmentB)).toEqual(
    deny("AuthorityInactive"),
  );
  expect(mapOrganizationAuthorityToRecruitmentActor(inactiveLeader, departmentB)).toEqual(
    deny("AuthorityInactive"),
  );
  expect(mapOrganizationAuthorityToProfileRole(inactiveLeader)).toEqual(deny("AuthorityInactive"));

  const inactiveMember = authority("Absent", [
    membership("membership-inactive-member", "team-inactive-member", departmentA, false, false),
  ]);

  expect(mapOrganizationAuthorityToAdmissionPeriodActor(inactiveMember, departmentA)).toEqual(
    deny("AuthorityInactive"),
  );
});

it("distinguishes Profile absence from known inactive authority", () => {
  expect(mapOrganizationAuthorityToProfileRole(authority("Absent", []))).toEqual(
    deny("NotInScope"),
  );
  expect(mapOrganizationAuthorityToProfileRole(authority("Inactive", []))).toEqual(
    deny("AuthorityInactive"),
  );
  expect(
    mapOrganizationAuthorityToProfileRole(
      authority("Absent", [
        membership("membership-history", "team-history", departmentA, false, false),
      ]),
    ),
  ).toEqual(deny("AuthorityInactive"));
});

it("uses leader before member for active Profile authority across departments", () => {
  const projection = authority("Absent", [
    membership("membership-member-a", "team-member-a", departmentA, true, false),
    membership("membership-leader-b", "team-leader-b", departmentB, true, true),
  ]);

  expect(mapOrganizationAuthorityToProfileRole(projection)).toEqual(allow("ROLE_TEAM_LEADER"));
  expect(mapOrganizationAuthorityToOrganizationActor(projection)).toEqual(
    OrganizationMemberSchema.make({ personId }),
  );
});

it("shares the frozen spec0055 accepted and rejected fixtures with PostgreSQL proof", () => {
  const fixtures = spec0055OrganizationAuthorityFixtures({
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
  expect(mapOrganizationAuthorityToRecruitmentActor(fixtures.inactiveLeader, departmentA)).toEqual(
    deny("AuthorityInactive"),
  );
  expect(mapOrganizationAuthorityToOrganizationActor(fixtures.administrator)._tag).toBe(
    "OrganizationAdministrator",
  );
  expect(mapOrganizationAuthorityToOrganizationActor(fixtures.member)._tag).toBe(
    "OrganizationMember",
  );
  expect(mapOrganizationAuthorityToProfileRole(fixtures.absent)).toEqual(deny("NotInScope"));
});
