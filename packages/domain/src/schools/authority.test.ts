import { describe, expect, it } from "vitest";
import {
  OrganizationAuthorityInstantSchema,
  type OrganizationAuthorityMembership,
  type OrganizationGlobalAdministratorStatus,
  type OrganizationPersonAuthority,
} from "../organization/authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "../organization/schema.js";
import { resolveSchoolsDirectoryScope } from "./authority.js";

const authorizationInstant = OrganizationAuthorityInstantSchema.make("2032-01-01T00:00:00.000Z");
const personId = PersonId.make("schools-reader");

const membership = (
  suffix: string,
  departmentId: string,
  active: boolean,
  teamLeader = false,
): OrganizationAuthorityMembership => ({
  membershipId: MembershipId.make(`membership-${suffix}`),
  teamId: TeamId.make(`team-${suffix}`),
  departmentId: DepartmentId.make(departmentId),
  active,
  teamLeader,
});

const authority = (
  globalAdministrator: OrganizationGlobalAdministratorStatus,
  memberships: ReadonlyArray<OrganizationAuthorityMembership>,
): OrganizationPersonAuthority => ({
  personId,
  evaluatedAt: authorizationInstant,
  globalAdministrator,
  memberships,
});

describe("Schools directory authority at one injected instant", () => {
  it("grants an active global administrator every department and unassigned schools", () => {
    expect(resolveSchoolsDirectoryScope(authority("Active", []))).toEqual({
      _tag: "Allow",
      value: { _tag: "All" },
    });
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
    ).toEqual({
      _tag: "Allow",
      value: {
        _tag: "DepartmentIds",
        departmentIds: ["bergen", "trondheim"],
      },
    });
  });

  it("denies memberships that exist but are all inactive", () => {
    expect(
      resolveSchoolsDirectoryScope(authority("Absent", [membership("ended", "bergen", false)])),
    ).toEqual({ _tag: "Deny", reason: "AuthorityInactive" });
  });

  it("denies an ended or future administrator grant with no active membership", () => {
    expect(resolveSchoolsDirectoryScope(authority("Inactive", []))).toEqual({
      _tag: "Deny",
      reason: "AuthorityInactive",
    });
  });

  it("distinguishes a person with no Organization authority record", () => {
    const projection = authority("Absent", []);
    expect(projection.evaluatedAt).toBe(authorizationInstant);
    expect(resolveSchoolsDirectoryScope(projection)).toEqual({
      _tag: "Deny",
      reason: "NotInScope",
    });
  });
});
