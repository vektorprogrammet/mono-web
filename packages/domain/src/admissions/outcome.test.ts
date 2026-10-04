import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AdmissionOutcome,
  AdmissionOutcomeCommand,
  admissionOutcomePermission,
  canAnnounceAdmissionOutcome,
} from "./outcome.js";
import { OrganizationPersonAuthoritySchema } from "../organization/authority.js";
import { DelegationArea } from "../authz/delegation.js";
import { DepartmentId, PersonId } from "../organization/schema.js";

const departmentA = DepartmentId.make("a");

const departmentB = DepartmentId.make("b");

const evaluatedAt = "2026-09-06T10:00:00.000Z";

interface MembershipOverrides {
  readonly active?: boolean;
  readonly unitLeader?: boolean;
  readonly unitKind?: "Team" | "DepartmentBoard";
}

interface DelegationOverrides {
  readonly startAt?: string;
  readonly endAt?: string | null;
  readonly holders?: "AllMembers" | "LeadersOnly";
}

type DelegatedCapability = "admissions.outcomes" | "placements.coordinate";

const membership = (overrides: MembershipOverrides) => ({
  membershipId: "membership",
  teamId: "team",
  departmentId: departmentA,
  active: true,
  unitLeader: false,
  unitKind: "Team",
  teamScope: "HomeDepartment",
  departmentIndependent: true,
  ...overrides,
});

const authorityOf = (
  parts: {
    readonly globalAdministrator?: "Absent" | "Active" | "Inactive";
    readonly memberships?: ReadonlyArray<unknown>;
    readonly nationalBoardSeats?: ReadonlyArray<unknown>;
    readonly delegations?: ReadonlyArray<unknown>;
  } = {},
) =>
  Schema.decodeUnknownSync(OrganizationPersonAuthoritySchema)({
    personId: PersonId.make("person"),
    evaluatedAt,
    globalAdministrator: "Absent",
    memberships: [],
    nationalBoardSeats: [],
    delegations: [],
    ...parts,
  });

const delegation = (capability: DelegatedCapability, overrides: DelegationOverrides = {}) => ({
  delegationId: `delegation-${"c".repeat(64)}`,
  name: "Delegation",
  teamId: "team",
  capability,
  area: DelegationArea.cases.Department.make({ departmentId: departmentA }),
  holders: "AllMembers",
  startAt: "2026-08-01T00:00:00.000Z",
  endAt: null,
  revision: 0,
  ...overrides,
});

const delegatedMember = (
  capability: DelegatedCapability,
  overrides: DelegationOverrides = {},
  member: MembershipOverrides = {},
) =>
  authorityOf({
    memberships: [membership(member)],
    delegations: [delegation(capability, overrides)],
  });

describe("admission outcome values", () => {
  it("admits only Admitted and Rejected as an outcome and a command value", () => {
    expect(Schema.is(AdmissionOutcome)("Admitted")).toBe(true);
    expect(Schema.is(AdmissionOutcome)("Rejected")).toBe(true);
    expect(Schema.is(AdmissionOutcome)("Substitute")).toBe(false);
    expect(Schema.is(AdmissionOutcomeCommand)({ outcome: "Substitute" })).toBe(false);
  });
});

describe("admission outcome authority comes from delegation, not from leadership", () => {
  it("lets a team decide only through a current admissions.outcomes delegation (O8-12, O8-17)", () => {
    expect(admissionOutcomePermission(delegatedMember("admissions.outcomes"), departmentA)).toBe(
      "Decide",
    );
    // A delegation reaches only its own department.
    expect(admissionOutcomePermission(delegatedMember("admissions.outcomes"), departmentB)).toBe(
      "Denied",
    );
    // The end instant is exclusive: a delegation that ends now confers nothing.
    expect(
      admissionOutcomePermission(
        delegatedMember("admissions.outcomes", { endAt: evaluatedAt }),
        departmentA,
      ),
    ).toBe("Denied");
    expect(
      admissionOutcomePermission(
        delegatedMember("admissions.outcomes", { startAt: "2026-09-07T00:00:00.000Z" }),
        departmentA,
      ),
    ).toBe("Denied");
    // A delegation of another capability does not decide outcomes.
    expect(admissionOutcomePermission(delegatedMember("placements.coordinate"), departmentA)).toBe(
      "Denied",
    );
    // A delegation reaches only a person with an active membership of the delegated team.
    expect(
      admissionOutcomePermission(
        delegatedMember("admissions.outcomes", {}, { active: false }),
        departmentA,
      ),
    ).toBe("Denied");
    expect(
      admissionOutcomePermission(
        delegatedMember("admissions.outcomes", { holders: "LeadersOnly" }),
        departmentA,
      ),
    ).toBe("Denied");
    expect(
      admissionOutcomePermission(
        delegatedMember("admissions.outcomes", { holders: "LeadersOnly" }, { unitLeader: true }),
        departmentA,
      ),
    ).toBe("Decide");
  });

  it("lets only a delegated school coordinator announce", () => {
    expect(canAnnounceAdmissionOutcome(delegatedMember("placements.coordinate"), departmentA)).toBe(
      true,
    );
    expect(canAnnounceAdmissionOutcome(delegatedMember("placements.coordinate"), departmentB)).toBe(
      false,
    );
    expect(
      canAnnounceAdmissionOutcome(
        delegatedMember("placements.coordinate", { endAt: evaluatedAt }),
        departmentA,
      ),
    ).toBe(false);
    // Rekruttering decides but does not announce.
    expect(canAnnounceAdmissionOutcome(delegatedMember("admissions.outcomes"), departmentA)).toBe(
      false,
    );
  });

  it("gives a board leader without a delegation neither decision nor announcement", () => {
    const departmentBoardLeader = authorityOf({
      memberships: [membership({ unitKind: "DepartmentBoard", unitLeader: true })],
    });

    const nationalBoardLeader = authorityOf({
      nationalBoardSeats: [
        { membershipId: "seat", boardId: "board", active: true, unitLeader: true },
      ],
    });

    const teamLeader = authorityOf({ memberships: [membership({ unitLeader: true })] });

    for (const authority of [departmentBoardLeader, nationalBoardLeader, teamLeader]) {
      expect(admissionOutcomePermission(authority, departmentA)).toBe("Denied");
      expect(canAnnounceAdmissionOutcome(authority, departmentA)).toBe(false);
    }
  });

  it("keeps a plain department member out of both steps", () => {
    const member = authorityOf({ memberships: [membership({})] });

    expect(admissionOutcomePermission(member, departmentA)).toBe("Denied");
    expect(canAnnounceAdmissionOutcome(member, departmentA)).toBe(false);
  });

  it("keeps an active global administrator in both steps in every department", () => {
    const administrator = authorityOf({ globalAdministrator: "Active" });

    expect(admissionOutcomePermission(administrator, departmentB)).toBe("Decide");
    expect(canAnnounceAdmissionOutcome(administrator, departmentB)).toBe(true);

    // An ended grant confers nothing and leaves other authority as it is.
    const ended = authorityOf({ globalAdministrator: "Inactive" });

    expect(admissionOutcomePermission(ended, departmentA)).toBe("Denied");
    expect(canAnnounceAdmissionOutcome(ended, departmentA)).toBe(false);
  });
});
