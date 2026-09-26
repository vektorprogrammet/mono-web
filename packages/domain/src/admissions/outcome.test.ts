import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AdmissionOutcomeEntry, admissionOutcomePermission, onCallSubstitutes } from "./outcome.js";
import { OrganizationPersonAuthoritySchema } from "../organization/authority.js";
import { DelegationArea } from "../authz/delegation.js";
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
    const authority = Schema.decodeSync(OrganizationPersonAuthoritySchema)({
      personId: PersonId.make("person"),
      evaluatedAt: "2026-09-06T10:00:00.000Z",
      globalAdministrator: "Absent",
      memberships: [
        {
          membershipId: "first",
          teamId: "wrong",
          departmentId: DepartmentId.make("wrong"),
          active: true,
          unitLeader: true,
          unitKind: "Team",
          teamScope: "HomeDepartment",
          departmentIndependent: true,
        },
        {
          membershipId: "second",
          teamId: "right",
          departmentId: DepartmentId.make("a"),
          active: true,
          unitLeader: true,
          unitKind: "DepartmentBoard",
          teamScope: "HomeDepartment",
          departmentIndependent: true,
        },
      ],
      nationalBoardSeats: [],
      delegations: [],
    });

    expect(admissionOutcomePermission(authority, DepartmentId.make("a"))).toBe("Decide");
    // An ordinary team's leader acts within the team: the department's outcomes are read-only.
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

  it("lets a team decide outcomes only through a current delegation (O8-12, O8-17)", () => {
    const rekruttering = (delegations: ReadonlyArray<unknown>) =>
      Schema.decodeUnknownSync(OrganizationPersonAuthoritySchema)({
        personId: PersonId.make("recruiter"),
        evaluatedAt: "2026-09-06T10:00:00.000Z",
        globalAdministrator: "Absent",
        memberships: [
          {
            membershipId: "recruiter",
            teamId: "rekruttering",
            departmentId: DepartmentId.make("a"),
            active: true,
            unitLeader: false,
            unitKind: "Team",
            teamScope: "HomeDepartment",
            departmentIndependent: true,
          },
        ],
        nationalBoardSeats: [],
        delegations,
      });

    const delegation = {
      delegationId: `delegation-${"c".repeat(64)}`,
      name: "Rekruttering avgjør opptak",
      teamId: "rekruttering",
      capability: "admissions.outcomes",
      area: DelegationArea.cases.Department.make({ departmentId: DepartmentId.make("a") }),
      holders: "AllMembers",
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-09-06T10:00:00.000Z",
      revision: 1,
    };

    expect(admissionOutcomePermission(rekruttering([]), DepartmentId.make("a"))).toBe("ReadOnly");
    expect(
      admissionOutcomePermission(
        rekruttering([{ ...delegation, endAt: null, revision: 0 }]),
        DepartmentId.make("a"),
      ),
    ).toBe("Decide");
    // The end instant is exclusive.
    expect(admissionOutcomePermission(rekruttering([delegation]), DepartmentId.make("a"))).toBe(
      "ReadOnly",
    );
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
