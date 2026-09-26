import { deny, allow } from "../authz/decision.js";
import { SchoolDirectoryScopeSchema } from "./schema.js";
import { describe, expect, it } from "vitest";
import {
  OrganizationAuthorityInstantSchema,
  type OrganizationAuthorityMembership,
  type OrganizationGlobalAdministratorStatus,
  type OrganizationPersonAuthority,
} from "../organization/authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "../organization/schema.js";
import { resolveSchoolsDirectoryScope } from "./authority.js";
import { canManageSchoolDepartments } from "./administration.js";

const authorizationInstant = OrganizationAuthorityInstantSchema.make("2032-01-01T00:00:00.000Z");

const personId = PersonId.make("schools-reader");

/** A membership; `boardLeader` leads the board of an independent department. */
const membership = (
  suffix: string,
  departmentId: string,
  active: boolean,
  boardLeader = false,
): OrganizationAuthorityMembership => ({
  membershipId: MembershipId.make(`membership-${suffix}`),
  teamId: TeamId.make(`team-${suffix}`),
  departmentId: DepartmentId.make(departmentId),
  active,
  unitLeader: boardLeader,
  unitKind: boardLeader ? "DepartmentBoard" : "Team",
  teamScope: "HomeDepartment",
  departmentIndependent: true,
});

const authority = (
  globalAdministrator: OrganizationGlobalAdministratorStatus,
  memberships: ReadonlyArray<OrganizationAuthorityMembership>,
): OrganizationPersonAuthority => ({
  personId,
  evaluatedAt: authorizationInstant,
  globalAdministrator,
  memberships,
  nationalBoardSeats: [],
  delegations: [],
});

describe("Schools maintenance scope", () => {
  it("requires global authority for an unassociated school", () => {
    const leader = authority("Absent", [membership("a", "a", true, true)]);
    expect(canManageSchoolDepartments(leader, [])).toBe(false);
    expect(canManageSchoolDepartments(authority("Active", []), [])).toBe(true);
  });
  it("gives an ordinary team leader no school administration (O8-11)", () => {
    const teamLeader = authority("Absent", [
      { ...membership("a", "a", true, true), unitKind: "Team" },
    ]);

    expect(canManageSchoolDepartments(teamLeader, [DepartmentId.make("a")])).toBe(false);
  });

  it("requires current board leadership for every affected department", () => {
    const leader = authority("Inactive", [
      membership("a", "a", true, true),
      membership("b", "b", true),
      membership("c", "c", false, true),
    ]);

    expect(canManageSchoolDepartments(leader, [DepartmentId.make("a")])).toBe(true);
    expect(
      canManageSchoolDepartments(leader, [DepartmentId.make("a"), DepartmentId.make("b")]),
    ).toBe(false);
    expect(canManageSchoolDepartments(leader, [DepartmentId.make("c")])).toBe(false);
  });
});

describe("Schools directory authority at one injected instant", () => {
  it("grants an active global administrator every department and unassigned schools", () => {
    expect(resolveSchoolsDirectoryScope(authority("Active", []))).toEqual(
      allow(SchoolDirectoryScopeSchema.cases.All.make({})),
    );
  });

  it("unions every active membership without giving leadership extra authority", () => {
    expect(
      resolveSchoolsDirectoryScope(
        authority("Inactive", [
          membership("trondheim-member", "trondheim", true),
          membership("bergen-leader", "bergen", true, true),
          membership("bergen-duplicate", "bergen", true),
          membership("oslo-ended", "oslo", false, true),
        ]),
      ),
    ).toEqual(
      allow(
        SchoolDirectoryScopeSchema.cases.DepartmentIds.make({
          departmentIds: [DepartmentId.make("bergen"), DepartmentId.make("trondheim")],
        }),
      ),
    );
  });

  it("denies memberships that exist but are all inactive", () => {
    expect(
      resolveSchoolsDirectoryScope(authority("Absent", [membership("ended", "bergen", false)])),
    ).toEqual(deny("AuthorityInactive"));
  });

  it("denies an ended or future administrator grant with no active membership", () => {
    expect(resolveSchoolsDirectoryScope(authority("Inactive", []))).toEqual(
      deny("AuthorityInactive"),
    );
  });

  it("distinguishes a person with no Organization authority record", () => {
    const projection = authority("Absent", []);
    expect(projection.evaluatedAt).toBe(authorizationInstant);
    expect(resolveSchoolsDirectoryScope(projection)).toEqual(deny("NotInScope"));
  });
});
