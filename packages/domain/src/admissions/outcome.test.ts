import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AdmissionOutcomeEntry, admissionOutcomePermission, onCallSubstitutes } from "./outcome.js";
import { OrganizationPersonAuthoritySchema } from "../organization/authority.js";
import { DepartmentId, PersonId } from "../organization/schema.js";

const entry = (applicationId: string, outcome: string | null) =>
  Schema.decodeUnknownSync(AdmissionOutcomeEntry)({
    applicationId,
    admissionPeriodId: "period",
    departmentId: "a",
    semesterId: "semester",
    firstName: "Sofie",
    lastName: "Søker",
    email: "sofie@example.invalid",
    phone: "123",
    yearOfStudy: 3,
    outcome,
    revision: outcome === null ? 0 : 1,
  });

describe("admission outcome authority and member visibility", () => {
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

    expect(admissionOutcomePermission(authority, DepartmentId.make("a"))).toBe("Decide");
    expect(admissionOutcomePermission(authority, DepartmentId.make("wrong"))).toBe("ReadOnly");
    expect(admissionOutcomePermission(authority, DepartmentId.make("absent"))).toBe("Denied");
    // An ended administrator grant leaves the memberships' authority as it is.
    const ended = { ...authority, globalAdministrator: "Inactive" as const };
    expect(admissionOutcomePermission(ended, DepartmentId.make("a"))).toBe("Decide");
    expect(admissionOutcomePermission(ended, DepartmentId.make("wrong"))).toBe("ReadOnly");
    expect(admissionOutcomePermission(ended, DepartmentId.make("absent"))).toBe("Denied");
    expect(
      admissionOutcomePermission(
        { ...authority, globalAdministrator: "Active" },
        DepartmentId.make("absent"),
      ),
    ).toBe("Decide");
  });

  it("shows members only the name and contact of substitutes on call", () => {
    const visible = onCallSubstitutes([
      entry("app-admitted", "Admitted"),
      entry("app-substitute", "Substitute"),
      entry("app-rejected", "Rejected"),
      entry("app-undecided", null),
    ]);

    expect(visible).toEqual([
      {
        applicationId: "app-substitute",
        firstName: "Sofie",
        lastName: "Søker",
        email: "sofie@example.invalid",
        phone: "123",
      },
    ]);
  });
});
