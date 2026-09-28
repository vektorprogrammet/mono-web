import { expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Predicate, Result, Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { admissionOutcomePermission } from "../admissions/outcome.js";
import {
  mapOrganizationAuthorityToDepartmentActor,
  requireTeamInterestScope,
  type TeamInterestReadScope,
  OrganizationAuthorityBoardSeatSchema,
  OrganizationAuthorityMembershipSchema,
  OrganizationGlobalAdministratorStatusSchema,
  OrganizationPersonAuthoritySchema,
} from "../organization/authority.js";
import { spec0055OrganizationAuthorityFixtures } from "../organization/authority-fixtures.test-support.js";
import { DepartmentId, TeamId } from "../organization/schema.js";
import { canManagePlacements } from "../placements/policy.js";
import type { OrganizationOperations } from "../organization/service.js";
import type { PlacementExecution } from "../placements/service.js";
import {
  requireSocialEventCreation,
  type SocialEventCreation,
} from "../social-events/authority.js";
import type { SocialEventsOperations } from "../social-events/service.js";
import type { AdmissionsOperations } from "../admissions/service.js";
import {
  Delegation,
  DelegationArea,
  DelegationId,
  ORGANIZATION_CAPABILITIES,
  ORGANIZATION_CAPABILITY_IDS,
  OrganizationCapability,
} from "./delegation.js";
import {
  type DepartmentReach,
  DepartmentReachDenied,
  ReachedDepartments,
  reachedDepartments,
  reachedTeams,
  reaches,
  ReachTarget,
  requireDepartmentReach,
} from "./reach.js";

const fixtures = spec0055OrganizationAuthorityFixtures({
  evaluatedAt: "2026-09-28T12:00:00.000Z",
  departmentId: "reach-department-a",
  teamId: "reach-team",
  persons: {
    administrator: "reach-administrator",
    leader: "reach-leader",
    inactiveLeader: "reach-inactive-leader",
    member: "reach-member",
    absent: "reach-absent",
  },
  memberships: {
    leader: "reach-leader-membership",
    inactiveLeader: "reach-inactive-leader-membership",
    member: "reach-member-membership",
  },
});

/** A small pool, so generated appointments land in the department under test. */
const departments = ["reach-department-a", "reach-department-b", "reach-department-c"] as const;

const department = Arbitrary.map(Arbitrary.schema(Schema.Literals(departments)), (id) =>
  DepartmentId.make(id),
);

/** A small pool of teams, shared by appointments and delegations, so delegations can apply. */
const teams = ["reach-team-a", "reach-team-b"] as const;

const team = Arbitrary.map(Arbitrary.schema(Schema.Literals(teams)), (id) => TeamId.make(id));

const membership = Arbitrary.map(
  Arbitrary.all({
    fields: Arbitrary.schema(OrganizationAuthorityMembershipSchema),
    department,
    team,
  }),
  ({ fields, department, team }) => ({ ...fields, departmentId: department, teamId: team }),
);

/**
 * Delegations of the pooled teams, current, ended, or future at the fixtures' instant. Their
 * interval is chosen, not generated: the RFC 3339 filter exhausts the schema arbitrary.
 */
const delegation = Arbitrary.map(
  Arbitrary.all({
    team,
    capability: Arbitrary.schema(OrganizationCapability),
    area: Arbitrary.schema(Schema.Literals(["Organization", ...departments])),
    holders: Arbitrary.schema(Schema.Literals(["AllMembers", "LeadersOnly"])),
    interval: Arbitrary.schema(Schema.Literals(["Current", "Ended", "Future"])),
  }),
  ({ team, capability, area, holders, interval }) =>
    Delegation.make({
      delegationId: DelegationId.make(`delegation-${"c".repeat(64)}`),
      name: "Generated delegation",
      teamId: team,
      capability,
      area:
        area === "Organization"
          ? DelegationArea.cases.Organization.make({})
          : DelegationArea.cases.Department.make({ departmentId: DepartmentId.make(area) }),
      holders,
      startAt: interval === "Future" ? "2026-10-01T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
      endAt: interval === "Ended" ? "2026-06-01T00:00:00.000Z" : null,
      revision: 0,
    }),
);

/**
 * A fixture person and instant with every global-administrator status, generated team and board
 * appointments in the pooled departments and teams, national board seats, and delegations.
 * Instants are not generated: the RFC 3339 filter exhausts the schema arbitrary.
 */
const authority = Arbitrary.map(
  Arbitrary.all({
    base: Arbitrary.schema(
      Schema.Literals(["administrator", "leader", "inactiveLeader", "member", "absent"]),
    ),
    globalAdministrator: Arbitrary.schema(OrganizationGlobalAdministratorStatusSchema),
    memberships: Arbitrary.array(membership, { maxLength: 4 }),
    nationalBoardSeats: Arbitrary.schema(Schema.Array(OrganizationAuthorityBoardSeatSchema)),
    delegations: Arbitrary.array(delegation, { maxLength: 2 }),
  }),
  ({ base, ...facts }) => OrganizationPersonAuthoritySchema.make({ ...fixtures[base], ...facts }),
);

const capability = Arbitrary.schema(OrganizationCapability);

const propertyOptions = { arbitrary: { seed: 28092026, runs: 300 } } as const;

it.effect("requireDepartmentReach returns evidence for a board leader and denies a member", () =>
  Effect.gen(function* () {
    const departmentId = DepartmentId.make("reach-department-a");

    const leader = yield* Effect.fromResult(
      requireDepartmentReach(fixtures.leader, "admissions.outcomes", departmentId),
    );

    expect(leader).toMatchObject({
      personId: fixtures.leader.personId,
      capability: "admissions.outcomes",
      departmentId,
    });

    const denied = yield* Effect.flip(
      Effect.fromResult(
        requireDepartmentReach(fixtures.member, "admissions.outcomes", departmentId),
      ),
    );

    expect(denied).toEqual(
      new DepartmentReachDenied({
        personId: fixtures.member.personId,
        capability: "admissions.outcomes",
        departmentId,
      }),
    );
  }),
);

it.prop(
  "requireDepartmentReach grants evidence exactly where reaches holds, naming the person, capability, and department",
  { authority, capability, department },
  ({ authority, capability, department }) => {
    const result = requireDepartmentReach(authority, capability, department);

    expect(Result.isSuccess(result)).toBe(
      reaches(authority, capability, ReachTarget.Department({ departmentId: department })),
    );

    const facts = Result.isSuccess(result) ? result.success : result.failure;
    expect(facts.personId).toBe(authority.personId);
    expect(facts.capability).toBe(capability);
    expect(facts.departmentId).toBe(department);
  },
  propertyOptions,
);

it.prop(
  "requireDepartmentReach agrees with department administration where a global administrator holds the capability",
  { authority, department },
  ({ authority, department }) => {
    for (const capability of ORGANIZATION_CAPABILITY_IDS) {
      if (!ORGANIZATION_CAPABILITIES[capability].globalAdministrator) continue;

      const decision = mapOrganizationAuthorityToDepartmentActor(authority, capability, department);

      expect(Result.isSuccess(requireDepartmentReach(authority, capability, department))).toBe(
        Predicate.isTagged(decision, "Allow") && !Predicate.isTagged(decision.value, "Member"),
      );
    }
  },
  propertyOptions,
);

it.prop(
  "requireDepartmentReach replaces the placement coordinator and outcome decider checks",
  { authority, department },
  ({ authority, department }) => {
    expect(
      Result.isSuccess(requireDepartmentReach(authority, "placements.coordinate", department)),
    ).toBe(canManagePlacements(authority, department));

    expect(
      Result.isSuccess(requireDepartmentReach(authority, "admissions.outcomes", department)),
    ).toBe(admissionOutcomePermission(authority, department) === "Decide");
  },
  propertyOptions,
);

const requested = Arbitrary.map(
  Arbitrary.schema(Schema.Literals(["none", ...departments])),
  (id) => (id === "none" ? undefined : DepartmentId.make(id)),
);

it.prop(
  "requireTeamInterestScope reads only what team-interest.read reaches, inside the requested department",
  { authority, requested },
  ({ authority, requested }) => {
    const known = departments.map((id) => DepartmentId.make(id));
    const result = requireTeamInterestScope(authority, { requested, departments: known });
    const reached = reachedDepartments(authority, "team-interest.read");
    const readable = ReachedDepartments.$is("All")(reached) ? known : reached.departmentIds;
    const teams = reachedTeams(authority, "team-interest.read");

    // A reached team is read in the department of the person's appointment to it.
    const teamDepartments = teams.flatMap((teamId) => {
      const membership = authority.memberships.find((entry) => entry.teamId === teamId);

      return membership === undefined ? [] : [membership.departmentId];
    });

    const organizationWide = ReachedDepartments.$is("All")(reached);

    const readableHere =
      requested === undefined
        ? organizationWide || readable.length > 0 || teamDepartments.length > 0
        : readable.includes(requested) || teamDepartments.includes(requested);

    expect(Result.isSuccess(result)).toBe(readableHere);

    if (Result.isFailure(result)) {
      expect(result.failure.personId).toBe(authority.personId);

      return;
    }

    const scope = result.success;
    expect(scope.personId).toBe(authority.personId);

    for (const departmentId of scope.departmentIds) {
      expect(readable).toContain(departmentId);

      if (requested !== undefined) expect(departmentId).toBe(requested);
    }

    for (const team of scope.teams) {
      expect(teams).toContain(team.teamId);
      expect(scope.departmentIds).not.toContain(team.departmentId);

      if (requested !== undefined) expect(team.departmentId).toBe(requested);
    }
  },
  propertyOptions,
);

it.prop(
  "requireSocialEventCreation admits an active global administrator anywhere and an active appointment in the department",
  { authority, department },
  ({ authority, department }) => {
    const result = requireSocialEventCreation(authority, department);

    expect(Result.isSuccess(result)).toBe(
      authority.globalAdministrator === "Active" ||
        authority.memberships.some(
          (membership) => membership.active && membership.departmentId === department,
        ),
    );

    const facts = Result.isSuccess(result) ? result.success : result.failure;
    expect(facts.personId).toBe(authority.personId);
    expect(facts.departmentId).toBe(department);
  },
  propertyOptions,
);

it("requireDepartmentReach evidence is the only way to satisfy a department-scoped command", () => {
  type OutcomeDecider = Parameters<AdmissionsOperations["recordAdmissionOutcome"]>[0]["decider"];

  type Coordinator = Extract<PlacementExecution, { readonly coordinator: unknown }>["coordinator"];

  expectTypeOf<OutcomeDecider>().toEqualTypeOf<DepartmentReach<"admissions.outcomes">>();
  expectTypeOf<Coordinator>().toEqualTypeOf<DepartmentReach<"placements.coordinate">>();

  // Negative controls: a literal of the evidence's visible shape, or another capability's
  // evidence, is not evidence for the command.
  expectTypeOf<{
    readonly personId: OutcomeDecider["personId"];
    readonly capability: "admissions.outcomes";
    readonly departmentId: OutcomeDecider["departmentId"];
  }>().not.toExtend<OutcomeDecider>();
  expectTypeOf<DepartmentReach<"placements.coordinate">>().not.toExtend<OutcomeDecider>();
  expectTypeOf<DepartmentReach<"admissions.outcomes">>().not.toExtend<Coordinator>();

  // A creator's person id is not creation evidence.
  expectTypeOf<
    Parameters<SocialEventsOperations["create"]>[0]
  >().toEqualTypeOf<SocialEventCreation>();
  expectTypeOf<{
    readonly personId: SocialEventCreation["personId"];
    readonly departmentId: SocialEventCreation["departmentId"];
  }>().not.toExtend<SocialEventCreation>();

  // A handler-built filter is not a team-interest scope.
  expectTypeOf<{
    readonly personId: TeamInterestReadScope["personId"];
    readonly departmentIds: TeamInterestReadScope["departmentIds"];
    readonly teams: TeamInterestReadScope["teams"];
  }>().not.toExtend<TeamInterestReadScope>();
  expectTypeOf<
    Parameters<OrganizationOperations["listTeamInterestRegistrations"]>[0]
  >().toEqualTypeOf<TeamInterestReadScope>();

  // A board or coverage-board change cannot run on a person's own actor id.
  expectTypeOf<{
    readonly mutation: Extract<PlacementExecution, { readonly coordinator: unknown }>["mutation"];
    readonly actor: OutcomeDecider["personId"];
    readonly now: string;
    readonly commandId: string;
  }>().not.toExtend<PlacementExecution>();
});
