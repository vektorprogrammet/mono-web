import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import type {
  OrganizationAuthorityMembership,
  OrganizationPersonAuthority,
} from "../organization/authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "../organization/schema.js";
import {
  DELEGABLE_CAPABILITY_IDS,
  type Delegation,
  DelegationArea,
  DelegationCommand,
  DelegationId,
  type DelegationTransitionFailure,
  type DelegationTeam,
  ORGANIZATION_CAPABILITIES,
  transitionDelegation,
} from "./delegation.js";
import { reachedDepartments, ReachedDepartments, reaches, ReachTarget } from "./reach.js";

const trondheim = DepartmentId.make("department-trondheim");

const oslo = DepartmentId.make("department-oslo");

const rekruttering = TeamId.make("team-rekruttering");

const okonomi = TeamId.make("team-okonomi");

const start = "2026-09-01T00:00:00.000Z";

const end = "2026-12-01T00:00:00.000Z";

const delegationId = DelegationId.make(`delegation-${"a".repeat(64)}`);

const membership = (
  teamId: TeamId,
  departmentId: DepartmentId,
  input: {
    readonly active?: boolean;
    readonly leader?: boolean;
    readonly national?: boolean;
    readonly board?: boolean;
  } = {},
): OrganizationAuthorityMembership => ({
  membershipId: MembershipId.make(`membership-${teamId}`),
  teamId,
  departmentId,
  active: input.active ?? true,
  unitLeader: input.leader ?? false,
  unitKind: input.board === true ? "DepartmentBoard" : "Team",
  teamScope: input.national === true ? "National" : "HomeDepartment",
  departmentIndependent: true,
});

const delegation = (input: Partial<Delegation> = {}): Delegation => ({
  delegationId,
  name: "Rekruttering tar opptak",
  teamId: rekruttering,
  capability: "admissions.outcomes",
  area: DelegationArea.cases.Department.make({ departmentId: trondheim }),
  holders: "AllMembers",
  startAt: start,
  endAt: end,
  revision: 0,
  ...input,
});

const at = (
  evaluatedAt: string,
  memberships: ReadonlyArray<OrganizationAuthorityMembership>,
  delegations: ReadonlyArray<Delegation>,
): OrganizationPersonAuthority => ({
  personId: PersonId.make("person-reach"),
  evaluatedAt,
  globalAdministrator: "Absent",
  memberships,
  nationalBoardSeats: [],
  delegations,
});

const inTrondheim = ReachTarget.Department({ departmentId: trondheim });

describe("delegated reach", () => {
  const rekrutteringMember = [membership(rekruttering, trondheim)];

  it("gives exactly its capability in its area during its half-open interval", () => {
    const delegations = [delegation()];

    expect(
      reaches(
        at("2026-08-31T23:59:59.999Z", rekrutteringMember, delegations),
        "admissions.outcomes",
        inTrondheim,
      ),
    ).toBe(false);
    expect(
      reaches(at(start, rekrutteringMember, delegations), "admissions.outcomes", inTrondheim),
    ).toBe(true);
    expect(
      reaches(
        at("2026-11-30T23:59:59.999Z", rekrutteringMember, delegations),
        "admissions.outcomes",
        inTrondheim,
      ),
    ).toBe(true);
    expect(
      reaches(at(end, rekrutteringMember, delegations), "admissions.outcomes", inTrondheim),
    ).toBe(false);

    const during = at("2026-10-01T00:00:00.000Z", rekrutteringMember, delegations);

    expect(reaches(during, "admissions.periods", inTrondheim)).toBe(false);
    expect(
      reaches(during, "admissions.outcomes", ReachTarget.Department({ departmentId: oslo })),
    ).toBe(false);
    expect(reachedDepartments(during, "admissions.outcomes")).toEqual(
      ReachedDepartments.Departments({ departmentIds: [trondheim] }),
    );
  });

  it("reaches only current members of the delegated team", () => {
    const during = "2026-10-01T00:00:00.000Z";

    expect(
      reaches(
        at(during, [membership(rekruttering, trondheim, { active: false })], [delegation()]),
        "admissions.outcomes",
        inTrondheim,
      ),
    ).toBe(false);
    expect(
      reaches(
        at(during, [membership(TeamId.make("team-other"), trondheim)], [delegation()]),
        "admissions.outcomes",
        inTrondheim,
      ),
    ).toBe(false);
  });

  it("reaches only the leaders of a leaders-only delegation", () => {
    const during = "2026-10-01T00:00:00.000Z";
    const leadersOnly = [delegation({ holders: "LeadersOnly" })];

    expect(
      reaches(
        at(during, [membership(rekruttering, trondheim)], leadersOnly),
        "admissions.outcomes",
        inTrondheim,
      ),
    ).toBe(false);
    expect(
      reaches(
        at(during, [membership(rekruttering, trondheim, { leader: true })], leadersOnly),
        "admissions.outcomes",
        inTrondheim,
      ),
    ).toBe(true);
  });

  it("confers nothing once its team's area no longer covers its area", () => {
    const during = "2026-10-01T00:00:00.000Z";

    const national = [
      delegation({
        teamId: okonomi,
        capability: "people.read",
        area: DelegationArea.cases.Department.make({ departmentId: oslo }),
      }),
    ];

    const toOslo = ReachTarget.Department({ departmentId: oslo });

    expect(
      reaches(
        at(during, [membership(okonomi, trondheim, { national: true })], national),
        "people.read",
        toOslo,
      ),
    ).toBe(true);
    expect(
      reaches(at(during, [membership(okonomi, trondheim)], national), "people.read", toOslo),
    ).toBe(false);
    expect(
      reaches(
        at(during, [membership(okonomi, trondheim, { board: true })], national),
        "people.read",
        toOslo,
      ),
    ).toBe(false);
  });

  it("settles only through leaders-only national delegations", () => {
    const during = "2026-10-01T00:00:00.000Z";
    const organization = DelegationArea.cases.Organization.make({});
    const receipt = ReachTarget.Organization();

    const economy = [
      delegation({ teamId: okonomi, capability: "receipts.approve", area: organization }),
      delegation({
        delegationId: DelegationId.make(`delegation-${"b".repeat(64)}`),
        teamId: okonomi,
        capability: "receipts.settle",
        area: organization,
        holders: "LeadersOnly",
      }),
    ];

    const economyMember = at(during, [membership(okonomi, trondheim, { national: true })], economy);

    const financeLead = at(
      during,
      [membership(okonomi, trondheim, { national: true, leader: true })],
      economy,
    );

    expect(reaches(economyMember, "receipts.approve", receipt)).toBe(true);
    expect(reaches(economyMember, "receipts.settle", receipt)).toBe(false);
    expect(reaches(financeLead, "receipts.settle", receipt)).toBe(true);
  });
});

describe("delegation transitions", () => {
  const now = "2026-09-15T00:00:00.000Z";

  const localTeam: DelegationTeam = {
    teamId: rekruttering,
    departmentId: trondheim,
    unitKind: "Team",
    teamScope: "HomeDepartment",
    active: true,
  };

  const issue = (input: Partial<Extract<DelegationCommand, { _tag: "IssueDelegation" }>>) =>
    DelegationCommand.cases.IssueDelegation.make({
      commandId: "command-issue",
      reason: "Semesterstart",
      name: "Rekruttering tar opptak",
      teamId: rekruttering,
      capability: "admissions.outcomes",
      area: DelegationArea.cases.Department.make({ departmentId: trondheim }),
      holders: "AllMembers",
      startAt: start,
      endAt: end,
      ...input,
    });

  const issued = (command: DelegationCommand, team: DelegationTeam = localTeam) =>
    transitionDelegation(undefined, command, { delegationId, team, now });

  it("issues every delegable capability to a team in its own area", () => {
    for (const capability of DELEGABLE_CAPABILITY_IDS) {
      const rule = ORGANIZATION_CAPABILITIES[capability].delegation;
      const national = rule !== "TeamArea";

      const result = issued(
        issue({
          capability,
          area: national
            ? DelegationArea.cases.Organization.make({})
            : DelegationArea.cases.Department.make({ departmentId: trondheim }),
          holders: rule === "NationalLeaders" ? "LeadersOnly" : "AllMembers",
        }),
        national ? { ...localTeam, teamScope: "National" } : localTeam,
      );

      expect(Result.isSuccess(result)).toBe(true);
    }
  });

  it("rejects an area outside the team's area, a board, and settlement to all members", () => {
    const invalid = (result: Result.Result<Delegation, DelegationTransitionFailure>) =>
      Result.isFailure(result) && result.failure.code === "Invalid";

    expect(
      invalid(
        issued(issue({ area: DelegationArea.cases.Department.make({ departmentId: oslo }) })),
      ),
    ).toBe(true);
    expect(invalid(issued(issue({ area: DelegationArea.cases.Organization.make({}) })))).toBe(true);
    expect(invalid(issued(issue({}), { ...localTeam, unitKind: "DepartmentBoard" }))).toBe(true);
    expect(
      invalid(
        issued(
          issue({
            capability: "receipts.settle",
            area: DelegationArea.cases.Organization.make({}),
            holders: "AllMembers",
          }),
          { ...localTeam, teamScope: "National" },
        ),
      ),
    ).toBe(true);
    expect(
      invalid(
        issued(issue({ capability: "receipts.approve" }), { ...localTeam, teamScope: "National" }),
      ),
    ).toBe(true);
    expect(invalid(issued(issue({ endAt: start })))).toBe(true);
  });

  it("ends a delegation at or after now, never later than its end", () => {
    const current = delegation();

    const ending = (endAt: string, expectedRevision = 0) =>
      transitionDelegation(
        current,
        DelegationCommand.cases.EndDelegation.make({
          commandId: "command-end",
          reason: "Ferdig",
          delegationId,
          expectedRevision,
          endAt,
        }),
        { delegationId, team: localTeam, now },
      );

    expect(Result.getOrThrow(ending(now))).toEqual({ ...current, endAt: now, revision: 1 });
    expect(Result.isFailure(ending("2026-09-14T00:00:00.000Z"))).toBe(true);
    expect(Result.isFailure(ending("2027-01-01T00:00:00.000Z"))).toBe(true);

    const stale = ending(now, 3);

    expect(Result.isFailure(stale) && stale.failure.code === "Stale").toBe(true);
  });
});
