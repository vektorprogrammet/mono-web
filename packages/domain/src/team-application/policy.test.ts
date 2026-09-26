import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { allow, deny } from "../authz/decision.js";
import type {
  OrganizationAuthorityMembership,
  OrganizationGlobalAdministratorStatus,
} from "../organization/authority.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "../organization/schema.js";
import {
  evaluateTeamApplicationIntake,
  isTeamApplicationIntakeOpen,
  mapOrganizationAuthorityToTeamApplicationActor,
  TeamApplicationIntakeState,
} from "./policy.js";
import { TeamApplicationActor } from "./schema.js";

const now = DateTime.makeUnsafe("2031-09-15T12:00:00.000Z");

const open = {
  teamActive: true,
  departmentActive: true,
  acceptApplication: true,
  deadline: null,
  teamEmail: "team@example.invalid",
  departmentEmail: "department@example.invalid",
} as const;

describe("team application intake", () => {
  it("closes at the deadline instant and stays open strictly before it", () => {
    expect(
      isTeamApplicationIntakeOpen({ ...open, deadline: "2031-09-15T12:00:00.001Z" }, now),
    ).toBe(true);
    expect(
      isTeamApplicationIntakeOpen({ ...open, deadline: "2031-09-15T12:00:00.000Z" }, now),
    ).toBe(false);
    expect(
      isTeamApplicationIntakeOpen({ ...open, deadline: "2031-09-15T14:00:00.000+02:00" }, now),
    ).toBe(false);
    expect(isTeamApplicationIntakeOpen(open, now)).toBe(true);
  });

  it("requires explicit acceptance and an active team and department", () => {
    expect(isTeamApplicationIntakeOpen({ ...open, acceptApplication: null }, now)).toBe(false);
    expect(isTeamApplicationIntakeOpen({ ...open, acceptApplication: false }, now)).toBe(false);
    expect(isTeamApplicationIntakeOpen({ ...open, teamActive: false }, now)).toBe(false);
    expect(isTeamApplicationIntakeOpen({ ...open, departmentActive: false }, now)).toBe(false);
  });

  it("uses the team mailbox, else the department mailbox, and closes without a deliverable one", () => {
    const closed = TeamApplicationIntakeState.Closed();

    expect(evaluateTeamApplicationIntake(open, now)).toEqual(
      TeamApplicationIntakeState.Open({ mailbox: "team@example.invalid" }),
    );
    expect(evaluateTeamApplicationIntake({ ...open, teamEmail: null }, now)).toEqual(
      TeamApplicationIntakeState.Open({ mailbox: "department@example.invalid" }),
    );
    // A present but undeliverable team mailbox closes intake instead of rerouting it.
    expect(
      evaluateTeamApplicationIntake({ ...open, teamEmail: "IT <it@example.invalid>" }, now),
    ).toEqual(closed);
    expect(
      evaluateTeamApplicationIntake({ ...open, teamEmail: "it@example.invalid " }, now),
    ).toEqual(closed);
    expect(
      evaluateTeamApplicationIntake(
        { ...open, teamEmail: null, departmentEmail: "department" },
        now,
      ),
    ).toEqual(closed);
  });
});

const teamId = TeamId.make("team-application-team");

const departmentId = DepartmentId.make("team-application-department");

const personId = PersonId.make("person");

const membership = (
  team: string,
  active: boolean,
  unitLeader: boolean,
): OrganizationAuthorityMembership => ({
  membershipId: MembershipId.make(`membership-${team}-${active}-${unitLeader}`),
  teamId: TeamId.make(team),
  departmentId,
  active,
  unitLeader,
  unitKind: "Team",
  teamScope: "HomeDepartment",
  departmentIndependent: false,
});

const actorFor = (
  memberships: ReadonlyArray<OrganizationAuthorityMembership>,
  globalAdministrator: OrganizationGlobalAdministratorStatus = "Absent",
) =>
  mapOrganizationAuthorityToTeamApplicationActor(
    {
      personId,
      evaluatedAt: "2031-09-15T12:00:00.000Z",
      globalAdministrator,
      memberships,
      nationalBoardSeats: [],
      delegations: [],
    },
    teamId,
  );

const member = allow(TeamApplicationActor.cases.TeamMember.make({ personId, teamId }));

const leader = allow(TeamApplicationActor.cases.TeamLeader.make({ personId, teamId }));

describe("team application authority", () => {
  it("grants only the team's current members and leader", () => {
    expect(actorFor([membership(teamId, true, false)])).toEqual(member);
    expect(actorFor([membership(teamId, true, false), membership(teamId, true, true)])).toEqual(
      leader,
    );
  });

  it("denies other teams, former or suspended members, and administrators without membership", () => {
    expect(actorFor([membership("another-team", true, true)])).toEqual(deny("NotInScope"));
    // Ended, suspended, and inactive-team memberships arrive inactive from the projection.
    expect(actorFor([membership(teamId, false, true)])).toEqual(deny("AuthorityInactive"));
    expect(actorFor([], "Active")).toEqual(deny("NotInScope"));
    expect(actorFor([membership(teamId, true, false)], "Active")).toEqual(member);
  });
});
