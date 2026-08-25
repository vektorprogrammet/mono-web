import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { Organization } from "./service.js";
import { Database, type DatabaseShape } from "../database/service.js";
import { OrganizationLive } from "./postgres-layer.js";
import { listOrganizationTeamInterestRegistrations } from "./postgres.js";
import { DepartmentId, MembershipInvariantSchema } from "./schema.js";

it.effect("decodes aliased PostgreSQL membership selections through the Model", () => {
  const selected = {
    membershipId: "membership-persisted-1",
    personId: "person-1",
    teamId: null,
    deletedTeamName: "Archived Platform",
    startAt: "2025-08-01T00:00:00.000Z",
    endAt: null,
    positionId: null,
    isTeamLeader: false,
    isSuspended: true,
    revision: 4,
  } as const;
  return Effect.gen(function* () {
    const membership = yield* Schema.decodeUnknownEffect(MembershipInvariantSchema)(selected, {
      onExcessProperty: "error",
    });
    expect(membership.teamId).toBeNull();
    expect(membership.deletedTeamName).toBe("Archived Platform");
    expect(membership.revision).toBe(4);
  });
});

it.effect("joins the referenced team name into team-interest rows", () => {
  let statement = "";
  const database = ((strings: TemplateStringsArray) => {
    statement = strings.join("?");
    return Effect.succeed([
      {
        registrationId: "1",
        submitterName: "Interested Person",
        submitterEmail: "interested@example.invalid",
        teamId: "team-1",
        teamName: "Platform",
        departmentId: "department-1",
        semesterId: null,
        submittedAt: "2031-09-15T10:00:00.000Z",
        revision: 0,
      },
    ]);
  }) as unknown as DatabaseShape;

  return Effect.gen(function* () {
    const registrations = yield* listOrganizationTeamInterestRegistrations({
      authorizedDepartmentIds: [DepartmentId.make("department-1")],
    });
    expect(statement).toContain("INNER JOIN organization_teams AS team");
    expect(statement).toContain('team.name AS "teamName"');
    expect(registrations[0]?.teamName).toBe("Platform");
  }).pipe(Effect.provideService(Database, database));
});

it("keeps OrganizationLive open on Database instead of closing the capability", () => {
  const layer: Layer.Layer<Organization, never, Database> = OrganizationLive;
  expect(layer).toBeDefined();
});
