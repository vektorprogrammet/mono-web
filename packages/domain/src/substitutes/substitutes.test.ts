import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { SubstituteEntry, SubstituteMutation } from "./schema.js";
import { substitutePermission } from "./policy.js";
import { OrganizationPersonAuthoritySchema } from "../organization/authority.js";
import { PersonId, DepartmentId } from "../organization/schema.js";

const preferences = {
  monday: false,
  tuesday: false,
  wednesday: false,
  thursday: false,
  friday: false,
  language: "Norwegian",
};

const entry = {
  applicationId: "app",
  admissionPeriodId: "period",
  departmentId: DepartmentId.make("a"),
  semesterId: "semester",
  firstName: "Sofie",
  lastName: "Søker",
  email: "sofie@example.invalid",
  phone: "123",
  yearOfStudy: 3,
  revision: 0,
};

describe("substitute ownership and declaration", () => {
  it("requires complete explicit preferences, while all unavailable is a valid declaration", () => {
    expect(
      Schema.decodeUnknownSync(SubstituteMutation)(
        { ...preferences, yearOfStudy: 3 },
        { onExcessProperty: "error" },
      ),
    ).toEqual({ ...preferences, yearOfStudy: 3 });

    for (const value of [
      { yearOfStudy: 3 },
      { ...preferences, yearOfStudy: 0 },
      { ...preferences, yearOfStudy: "3" },
      { ...preferences, yearOfStudy: 3, language: "French" },
      { ...preferences, yearOfStudy: 3, monday: "false" },
      { ...preferences, yearOfStudy: 3, departmentId: DepartmentId.make("forged") },
    ])
      expect(() =>
        Schema.decodeUnknownSync(SubstituteMutation)(value, { onExcessProperty: "error" }),
      ).toThrow();
  });
  it("cannot represent active membership without known preferences", () => {
    expect(() =>
      Schema.decodeUnknownSync(SubstituteEntry)({ ...entry, active: true, preferences: null }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(SubstituteEntry)({ ...entry, active: false, preferences: null })
        .active,
    ).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(SubstituteEntry)({
        ...entry,
        active: false,
        preferences: null,
        revision: -1,
      }),
    ).toThrow();
  });
  it("evaluates the requested department across all memberships using canonical authority rules", () => {
    const authority = Schema.decodeUnknownSync(OrganizationPersonAuthoritySchema)({
      personId: PersonId.make("person"),
      evaluatedAt: "2026-09-06T10:00:00.000Z",
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: "first",
          teamId: "wrong",
          departmentId: DepartmentId.make("wrong"),
          active: true,
          teamLeader: false,
        },
        {
          membershipId: "second",
          teamId: "right",
          departmentId: DepartmentId.make("a"),
          active: true,
          teamLeader: true,
        },
      ],
    });

    expect(substitutePermission(authority, DepartmentId.make("a"))).toBe("Manage");
    expect(substitutePermission(authority, DepartmentId.make("wrong"))).toBe("ReadOnly");
    expect(substitutePermission(authority, DepartmentId.make("absent"))).toBe("Denied");
    expect(
      substitutePermission(
        { ...authority, globalAdministrator: "Inactive" },
        DepartmentId.make("a"),
      ),
    ).toBe("Denied");
    expect(
      substitutePermission(
        { ...authority, globalAdministrator: "Active" },
        DepartmentId.make("absent"),
      ),
    ).toBe("Manage");
  });
});
