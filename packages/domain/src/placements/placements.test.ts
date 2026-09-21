import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { nextAffiliationStatus, canManagePlacements } from "./policy.js";
import { OwnAffiliationCommand, PlacementCommand, PlacementValues } from "./schema.js";
import { OrganizationPersonAuthoritySchema } from "../organization/authority.js";
import { DepartmentId } from "../organization/schema.js";
describe("volunteer affiliation authority and lifecycle", () => {
  it("requires self nomination before coordinator establishment and permits resubmission after rejection", () => {
    expect(nextAffiliationStatus("Absent", "Establish")).toBeNull();
    expect(nextAffiliationStatus("Absent", "Request")).toBe("Pending");
    expect(nextAffiliationStatus("Pending", "Request")).toBeNull();
    expect(nextAffiliationStatus("Pending", "Reject")).toBe("Inactive");
    expect(nextAffiliationStatus("Inactive", "Request")).toBe("Pending");
    expect(nextAffiliationStatus("Pending", "Establish")).toBe("Active");
    expect(nextAffiliationStatus("Active", "Withdraw")).toBeNull();
    expect(nextAffiliationStatus("Active", "Revoke")).toBe("Inactive");
    expect(nextAffiliationStatus("Pending", "Withdraw")).toBe("Inactive");
  });
  it("self nomination cannot carry a third-party person selector", () => {
    expect(() =>
      Schema.decodeUnknownSync(OwnAffiliationCommand)(
        { action: "Request", personId: "other" },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
  it("historical leadership and active membership in another department do not authorize placement", () => {
    const authority = Schema.decodeUnknownSync(OrganizationPersonAuthoritySchema)({
      personId: "coordinator",
      evaluatedAt: "2026-09-06T00:00:00.000Z",
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: "old",
          teamId: "old-team",
          departmentId: "b",
          active: false,
          teamLeader: true,
        },
        {
          membershipId: "current",
          teamId: "current-team",
          departmentId: "a",
          active: true,
          teamLeader: true,
        },
      ],
    });
    expect(canManagePlacements(authority, DepartmentId.make("a"))).toBe(true);
    expect(canManagePlacements(authority, DepartmentId.make("b"))).toBe(false);
    expect(
      canManagePlacements(
        { ...authority, globalAdministrator: "Inactive" },
        DepartmentId.make("b"),
      ),
    ).toBe(false);
  });
});
describe("placement boundaries", () => {
  const valid = { schoolId: 1, day: "Monday", workdays: 4, block: "Both" };
  it.each([
    { workdays: 0 },
    { workdays: 9 },
    { workdays: 1.5 },
    { day: "Saturday" },
    { block: "3" },
    { schoolId: 0 },
  ])("rejects invalid teaching assignment %j", (change) => {
    expect(() => Schema.decodeUnknownSync(PlacementValues)({ ...valid, ...change })).toThrow();
  });
  it("preserves all three distinct legacy block choices", () => {
    for (const block of ["1", "2", "Both"])
      expect(Schema.decodeUnknownSync(PlacementValues)({ ...valid, block }).block).toBe(block);
  });
  it("cannot change the person or semester of an existing placement", () => {
    expect(() =>
      Schema.decodeUnknownSync(PlacementCommand)(
        {
          action: "Edit",
          placementId: `placement-${"a".repeat(64)}`,
          ...valid,
          personId: "other",
          semesterId: "other",
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});
