import {
  OrganizationMemberSchema,
  OrganizationAdministratorSchema,
} from "./administration-schema.js";
import { deny, allow } from "../authz/decision.js";
import type { OrganizationCapability } from "../authz/delegation.js";
import { AdmissionPeriodActorSchema } from "../admission-period/schema.js";
import { expect, it } from "@effect/vitest";
import {
  mapOrganizationAuthorityToDepartmentActor,
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

const departmentCapabilities: ReadonlyArray<OrganizationCapability> = [
  "admissions.periods",
  "admissions.outcomes",
  "recruitment.interviews",
  "placements.coordinate",
];

/** An appointment on an ordinary team; `leader` makes it the team's leadership. */
const teamMembership = (
  membershipId: string,
  teamId: string,
  departmentId: DepartmentId,
  active: boolean,
  leader: boolean,
): OrganizationAuthorityMembership => ({
  membershipId: MembershipId.make(membershipId),
  teamId: TeamId.make(teamId),
  departmentId,
  active,
  unitLeader: leader,
  unitKind: "Team",
  teamScope: "HomeDepartment",
  departmentIndependent: false,
});

/** An appointment on a department's board (Styret). */
const boardMembership = (
  membershipId: string,
  departmentId: DepartmentId,
  active: boolean,
  leader: boolean,
  departmentIndependent: boolean,
): OrganizationAuthorityMembership => ({
  ...teamMembership(membershipId, `styret-${departmentId}`, departmentId, active, leader),
  unitKind: "DepartmentBoard",
  departmentIndependent,
});

const authority = (
  globalAdministrator: OrganizationGlobalAdministratorStatus,
  memberships: ReadonlyArray<OrganizationAuthorityMembership>,
  nationalBoardSeats: OrganizationPersonAuthority["nationalBoardSeats"] = [],
): OrganizationPersonAuthority => ({
  personId,
  evaluatedAt,
  globalAdministrator,
  memberships,
  nationalBoardSeats,
  delegations: [],
});

const administrator = (departmentId: DepartmentId) =>
  allow(
    AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
      personId,
      departmentId,
      active: true,
    }),
  );

const member = (departmentId: DepartmentId) =>
  allow(AdmissionPeriodActorSchema.cases.Member.make({ personId, departmentId, active: true }));

it("gives an ordinary team leader no department administration (O8-11)", () => {
  const projection = authority("Absent", [
    teamMembership("membership-leader", "team-b", departmentB, true, true),
  ]);

  for (const capability of departmentCapabilities) {
    expect(mapOrganizationAuthorityToDepartmentActor(projection, capability, departmentB)).toEqual(
      member(departmentB),
    );
  }

  expect(mapOrganizationAuthorityToProfileRole(projection)).toEqual(allow("ROLE_TEAM_LEADER"));
});

it("maps every requested department without selecting a primary department", () => {
  const projection = authority("Absent", [
    teamMembership("membership-a", "team-a", departmentA, true, false),
    boardMembership("membership-b", departmentB, true, true, true),
  ]);

  for (const capability of departmentCapabilities) {
    expect(mapOrganizationAuthorityToDepartmentActor(projection, capability, departmentA)).toEqual(
      member(departmentA),
    );
    expect(mapOrganizationAuthorityToDepartmentActor(projection, capability, departmentB)).toEqual(
      administrator(departmentB),
    );
    expect(mapOrganizationAuthorityToDepartmentActor(projection, capability, departmentC)).toEqual(
      deny("NotInScope"),
    );
  }

  expect(mapOrganizationAuthorityToProfileRole(projection)).toEqual(
    allow("ROLE_DEPARTMENT_ADMINISTRATOR"),
  );
});

it("lets a department's board govern only while the department is independent", () => {
  const dependent = authority("Absent", [
    boardMembership("membership-board", departmentB, true, true, false),
  ]);

  expect(
    mapOrganizationAuthorityToDepartmentActor(dependent, "admissions.periods", departmentB),
  ).toEqual(member(departmentB));
  expect(mapOrganizationAuthorityToProfileRole(dependent)).toEqual(allow("ROLE_TEAM_MEMBER"));

  const boardMember = authority("Absent", [
    boardMembership("membership-board-member", departmentB, true, false, true),
  ]);

  expect(
    mapOrganizationAuthorityToDepartmentActor(boardMember, "admissions.periods", departmentB),
  ).toEqual(member(departmentB));
});

it("lets the national board's leader administer every department without a grant", () => {
  const nationalLeader = authority(
    "Absent",
    [],
    [
      {
        membershipId: MembershipId.make("seat-leader"),
        boardId: "hs",
        active: true,
        unitLeader: true,
      },
    ],
  );

  for (const departmentId of [departmentA, departmentB, departmentC]) {
    expect(
      mapOrganizationAuthorityToDepartmentActor(nationalLeader, "admissions.periods", departmentId),
    ).toEqual(administrator(departmentId));
  }

  // A national board seat is no global-administrator grant.
  expect(mapOrganizationAuthorityToOrganizationActor(nationalLeader)).toEqual(
    OrganizationMemberSchema.make({ personId }),
  );

  const nationalMember = authority(
    "Absent",
    [],
    [
      {
        membershipId: MembershipId.make("seat-member"),
        boardId: "hs",
        active: true,
        unitLeader: false,
      },
    ],
  );

  expect(
    mapOrganizationAuthorityToDepartmentActor(nationalMember, "admissions.periods", departmentA),
  ).toEqual(deny("NotInScope"));
  expect(mapOrganizationAuthorityToProfileRole(nationalMember)).toEqual(allow("ROLE_TEAM_MEMBER"));
});

it("applies global-administrator and department role precedence", () => {
  const globalAdministrator = authority("Active", [
    boardMembership("membership-admin", departmentA, true, true, true),
  ]);

  expect(
    mapOrganizationAuthorityToDepartmentActor(
      globalAdministrator,
      "admissions.periods",
      departmentA,
    ),
  ).toEqual(allow(AdmissionPeriodActorSchema.cases.GlobalAdmin.make({ personId, active: true })));
  expect(mapOrganizationAuthorityToOrganizationActor(globalAdministrator)).toEqual(
    OrganizationAdministratorSchema.make({ personId }),
  );
  expect(mapOrganizationAuthorityToProfileRole(globalAdministrator)).toEqual(allow("ROLE_ADMIN"));

  const activeMemberAndInactiveLeader = authority("Absent", [
    teamMembership("membership-member", "team-member", departmentA, true, false),
    boardMembership("membership-old-leader", departmentA, false, true, true),
  ]);

  expect(
    mapOrganizationAuthorityToDepartmentActor(
      activeMemberAndInactiveLeader,
      "admissions.periods",
      departmentA,
    ),
  ).toEqual(member(departmentA));
  expect(mapOrganizationAuthorityToProfileRole(activeMemberAndInactiveLeader)).toEqual(
    allow("ROLE_TEAM_MEMBER"),
  );
});

it("keeps role authority when a global-administrator grant has ended", () => {
  const formerAdministrator = authority("Inactive", [
    boardMembership("membership-current-leader", departmentA, true, true, true),
    teamMembership("membership-current-member", "team-member", departmentB, true, false),
  ]);

  expect(
    mapOrganizationAuthorityToDepartmentActor(
      formerAdministrator,
      "admissions.periods",
      departmentA,
    ),
  ).toEqual(administrator(departmentA));
  expect(
    mapOrganizationAuthorityToDepartmentActor(
      formerAdministrator,
      "recruitment.interviews",
      departmentB,
    ),
  ).toEqual(member(departmentB));
  expect(mapOrganizationAuthorityToOrganizationActor(formerAdministrator)).toEqual(
    OrganizationMemberSchema.make({ personId }),
  );
  expect(mapOrganizationAuthorityToProfileRole(formerAdministrator)).toEqual(
    allow("ROLE_DEPARTMENT_ADMINISTRATOR"),
  );
  // Where no role reaches, the ended grant still names the denial.
  expect(
    mapOrganizationAuthorityToDepartmentActor(
      formerAdministrator,
      "admissions.periods",
      departmentC,
    ),
  ).toEqual(deny("AuthorityInactive"));
  expect(
    mapOrganizationAuthorityToDepartmentActor(
      authority("Inactive", []),
      "admissions.periods",
      departmentA,
    ),
  ).toEqual(deny("AuthorityInactive"));
});

it("denies inactive memberships with their reason at the mapper boundary", () => {
  const inactiveLeader = authority("Absent", [
    boardMembership("membership-inactive-leader", departmentB, false, true, true),
  ]);

  expect(
    mapOrganizationAuthorityToDepartmentActor(inactiveLeader, "admissions.periods", departmentB),
  ).toEqual(deny("AuthorityInactive"));
  expect(
    mapOrganizationAuthorityToDepartmentActor(
      inactiveLeader,
      "recruitment.interviews",
      departmentB,
    ),
  ).toEqual(deny("AuthorityInactive"));
  expect(mapOrganizationAuthorityToProfileRole(inactiveLeader)).toEqual(deny("AuthorityInactive"));

  const inactiveMember = authority("Absent", [
    teamMembership("membership-inactive-member", "team-inactive-member", departmentA, false, false),
  ]);

  expect(
    mapOrganizationAuthorityToDepartmentActor(inactiveMember, "admissions.periods", departmentA),
  ).toEqual(deny("AuthorityInactive"));
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
        teamMembership("membership-history", "team-history", departmentA, false, false),
      ]),
    ),
  ).toEqual(deny("AuthorityInactive"));
});

it("shares the spec0055 accepted and rejected fixtures with the PostgreSQL proof", () => {
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

  expect(
    mapOrganizationAuthorityToDepartmentActor(fixtures.leader, "admissions.periods", departmentA),
  ).toEqual(
    allow(
      AdmissionPeriodActorSchema.cases.DepartmentAdministrator.make({
        personId: fixtures.leader.personId,
        departmentId: departmentA,
        active: true,
      }),
    ),
  );
  expect(
    mapOrganizationAuthorityToDepartmentActor(
      fixtures.inactiveLeader,
      "recruitment.interviews",
      departmentA,
    ),
  ).toEqual(deny("AuthorityInactive"));
  expect(mapOrganizationAuthorityToOrganizationActor(fixtures.administrator)._tag).toBe(
    "OrganizationAdministrator",
  );
  expect(mapOrganizationAuthorityToOrganizationActor(fixtures.member)._tag).toBe(
    "OrganizationMember",
  );
  expect(mapOrganizationAuthorityToProfileRole(fixtures.absent)).toEqual(deny("NotInScope"));
});
