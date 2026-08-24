import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  accumulateOrganizationDirectoryFacts,
  directoryRowInScope,
  resolveDirectoryGateScope,
  type OrganizationDirectoryFacts,
} from "./directory.js";
import { decodeDirectoryCursor, encodeDirectoryCursor } from "../profile/postgres.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "./schema.js";
import type { OrganizationAuthorityMembership } from "./authority.js";

const instant = "2026-08-24T12:00:00.000Z" as const;
const departmentA = DepartmentId.make("department-a");
const departmentB = DepartmentId.make("department-b");
const person = PersonId.make("person-1");

const membership = (
  membershipId: string,
  _personId: PersonId,
  departmentId: DepartmentId,
  active: boolean,
  teamLeader = false,
): OrganizationAuthorityMembership => ({
  membershipId: MembershipId.make(membershipId),
  teamId: TeamId.make(`team-${membershipId}`),
  departmentId,
  active,
  teamLeader,
});

describe("accumulateOrganizationDirectoryFacts", () => {
  it("keeps every department of a multi-department person in one entry", () => {
    const facts = accumulateOrganizationDirectoryFacts({
      personIds: [person],
      instant,
      memberships: [
        { personId: person, departmentId: departmentB, active: true },
        { personId: person, departmentId: departmentA, active: true },
      ],
      grants: [],
    });
    const fact = facts.get(person);
    expect(fact).toEqual({
      departments: [departmentA, departmentB],
      isActive: true,
      globalAdministrator: "Absent",
    });
  });

  it("yields isActive false for historical, suspended, and deactivated-team memberships", () => {
    const endedBeforeInstant = accumulateOrganizationDirectoryFacts({
      personIds: [person],
      instant,
      memberships: [{ personId: person, departmentId: departmentA, active: false }],
      grants: [],
    });
    expect(endedBeforeInstant.get(person)?.isActive).toBe(false);
    expect(endedBeforeInstant.get(person)?.departments).toEqual([departmentA]);
  });

  it("never lets an active global-administrator grant override isActive", () => {
    const facts = accumulateOrganizationFactsWithGrant({
      grantStatus: "Active",
      membershipActive: false,
    });
    expect(fact(facts)).toEqual({
      departments: [departmentA],
      isActive: false,
      globalAdministrator: "Active",
    });
  });

  it("defaults to Absent for persons without any grant row", () => {
    const facts = accumulateOrganizationFactsWithGrant({
      grantStatus: undefined,
      membershipActive: true,
    });
    expect(fact(facts).globalAdministrator).toBe("Absent");
    expect(fact(facts).isActive).toBe(true);
  });

  it("reports Inactive grants beside inactive memberships without overriding them", () => {
    const facts = accumulateOrganizationFactsWithGrant({
      grantStatus: "Inactive",
      membershipActive: false,
    });
    expect(fact(facts).globalAdministrator).toBe("Inactive");
    expect(fact(facts).isActive).toBe(false);
  });
});

describe("resolveDirectoryGateScope", () => {
  const authority = (
    globalAdministrator: "Active" | "Inactive" | "Absent",
    memberships: ReadonlyArray<OrganizationAuthorityMembership>,
  ) => ({ personId: person, evaluatedAt: instant, globalAdministrator, memberships });

  it("admits an active global administrator to all departments", () => {
    expect(resolveDirectoryGateScope(authority("Active", []))).toEqual({
      _tag: "Allow",
      value: { _tag: "AllDepartments" },
    });
  });

  it("unions the leader departments of a cross-department leader", () => {
    const scope = resolveDirectoryGateScope(
      authority("Absent", [
        membership("m1", person, departmentA, true, true),
        membership("m2", person, departmentB, true, true),
        membership("m3", person, departmentB, true, false),
        membership("m4", person, departmentB, false, true),
      ]),
    );
    expect(scope).toEqual({
      _tag: "Allow",
      value: { _tag: "Departments", departmentIds: [departmentA, departmentB] },
    });
  });

  it("denies a plain member with AuthorityInactive", () => {
    expect(
      resolveDirectoryGateScope(
        authority("Absent", [membership("m1", person, departmentA, true, false)]),
      ),
    ).toEqual({ _tag: "Deny", reason: "AuthorityInactive" });
  });

  it("denies an inactive leader with AuthorityInactive", () => {
    expect(
      resolveDirectoryGateScope(
        authority("Absent", [membership("m1", person, departmentA, false, true)]),
      ),
    ).toEqual({ _tag: "Deny", reason: "AuthorityInactive" });
  });

  it("denies an inactive administrator with AuthorityInactive", () => {
    expect(resolveDirectoryGateScope(authority("Inactive", []))).toEqual({
      _tag: "Deny",
      reason: "AuthorityInactive",
    });
  });

  it("denies a person with no Organization authority record with NotInScope", () => {
    expect(resolveDirectoryGateScope(authority("Absent", []))).toEqual({
      _tag: "Deny",
      reason: "NotInScope",
    });
  });
});

describe("directoryRowInScope", () => {
  it("matches rows whose departments intersect the scope and rejects disjoint ones", () => {
    const scope = resolveDirectoryGateScope({
      personId: person,
      evaluatedAt: instant,
      globalAdministrator: "Absent",
      memberships: [membership("m1", person, departmentA, true, true)],
    });
    if (scope._tag !== "Allow") throw new Error("expected allowed leader scope");
    expect(directoryRowInScope(scope.value, [departmentA])).toBe(true);
    expect(directoryRowInScope(scope.value, [departmentA, departmentB])).toBe(true);
    expect(directoryRowInScope(scope.value, [])).toBe(false);
  });

  it("matches every row under the all-departments scope", () => {
    expect(directoryRowInScope({ _tag: "AllDepartments" }, [])).toBe(true);
    expect(directoryRowInScope({ _tag: "AllDepartments" }, [departmentB])).toBe(true);
  });
});

describe("directory cursors", () => {
  it("round-trips the last sort tuple", async () => {
    const tuple = { lastName: "Ærø", firstName: "Ada", personId: "person-42" };
    const decoded = await Effect.runPromise(decodeDirectoryCursor(encodeDirectoryCursor(tuple)));
    expect(decoded).toEqual(tuple);
  });

  it("rejects malformed cursors as typed decode failures", async () => {
    const malformed = [
      "not-base64-json!!",
      Buffer.from("[1,2]", "utf8").toString("base64"),
      Buffer.from(JSON.stringify(["v9", "a", "b", "c"]), "utf8").toString("base64"),
      Buffer.from(JSON.stringify("v1"), "utf8").toString("base64"),
    ];
    for (const cursor of malformed) {
      const failure = await Effect.runPromise(Effect.flip(decodeDirectoryCursor(cursor)));
      expect(failure._tag).toBe("ProfileDecodeError");
    }
  });
});

function fact(map: OrganizationDirectoryFacts) {
  const result = map.get(person);
  if (result === undefined) throw new Error("missing fact");
  return result;
}

function accumulateOrganizationFactsWithGrant(input: {
  grantStatus: "Active" | "Inactive" | "Absent" | undefined;
  membershipActive: boolean;
}) {
  return accumulateOrganizationDirectoryFacts({
    personIds: [person],
    instant,
    memberships: [{ personId: person, departmentId: departmentA, active: input.membershipActive }],
    grants:
      input.grantStatus === undefined
        ? []
        : [{ personId: person, globalAdministrator: input.grantStatus }],
  });
}
