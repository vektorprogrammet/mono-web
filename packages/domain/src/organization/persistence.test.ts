import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { Organization } from "./service.js";
import { Database, type DatabaseShape } from "../database/service.js";
import { OrganizationLive } from "./postgres-layer.js";
import {
  listOrganizationTeamInterestRegistrations,
  reinstateOrganizationMembership,
  reviseOrganizationMembership,
  suspendOrganizationMembership,
} from "./postgres.js";
import {
  DepartmentId,
  MembershipId,
  MembershipInvariantSchema,
  PersonId,
} from "./schema.js";
import type { MembershipRevisionCommand } from "./transitions.js";

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

it.effect("serializes every membership revision through the canonical person protocol", () =>
  Effect.gen(function* () {
    const commands: ReadonlyArray<MembershipRevisionCommand> = [
      {
        _tag: "ReviseMembership",
        membershipId: MembershipId.make("membership-revise"),
        expectedRevision: 0,
        endAt: null,
        positionId: null,
        isTeamLeader: true,
        isSuspended: false,
      },
      {
        _tag: "SuspendMembership",
        membershipId: MembershipId.make("membership-suspend"),
        expectedRevision: 0,
      },
      {
        _tag: "ReinstateMembership",
        membershipId: MembershipId.make("membership-reinstate"),
        expectedRevision: 0,
      },
    ];
    const canonicalPersonId = PersonId.make("canonical-membership-person");

    for (const command of commands) {
      const events: Array<{ readonly kind: string; readonly value: string }> = [];
      const current = {
        membershipId: command.membershipId,
        personId: canonicalPersonId,
        teamId: "membership-team",
        deletedTeamName: null,
        startAt: "2036-01-01T00:00:00.000Z",
        endAt: null,
        positionId: null,
        isTeamLeader: false,
        isSuspended: command._tag === "ReinstateMembership",
        revision: 0,
      };
      const next = {
        ...current,
        endAt: command._tag === "ReviseMembership" ? command.endAt : current.endAt,
        positionId:
          command._tag === "ReviseMembership" ? command.positionId : current.positionId,
        isTeamLeader:
          command._tag === "ReviseMembership" ? command.isTeamLeader : current.isTeamLeader,
        isSuspended:
          command._tag === "SuspendMembership"
            ? true
            : command._tag === "ReinstateMembership"
              ? false
              : command.isSuspended,
        revision: 1,
      };
      const sql = ((
        strings: TemplateStringsArray,
        ...values: ReadonlyArray<unknown>
      ): Effect.Effect<ReadonlyArray<unknown>> => {
        const statement = strings.join("?");
        if (statement.includes("FROM organization_memberships")) {
          events.push({ kind: "MembershipRowLock", value: command.membershipId });
          return Effect.succeed([current]);
        }
        if (statement.includes("pg_advisory_xact_lock")) {
          events.push({ kind: "PersonAuthorizationLock", value: String(values[0]) });
          return Effect.succeed([]);
        }
        if (statement.includes("UPDATE organization_memberships")) {
          events.push({ kind: "MembershipUpdate", value: command.membershipId });
          return Effect.succeed([next]);
        }
        return Effect.die(`Unexpected organization persistence statement: ${statement}`);
      }) as unknown as DatabaseShape;
      const database = Object.assign(sql, {
        withTransaction: <A, E, R>(program: Effect.Effect<A, E, R>) => program,
      });

      switch (command._tag) {
        case "ReviseMembership":
          yield* reviseOrganizationMembership(command).pipe(
            Effect.provideService(Database, database),
          );
          break;
        case "SuspendMembership":
          yield* suspendOrganizationMembership(command).pipe(
            Effect.provideService(Database, database),
          );
          break;
        case "ReinstateMembership":
          yield* reinstateOrganizationMembership(command).pipe(
            Effect.provideService(Database, database),
          );
          break;
      }

      expect(events).toEqual([
        { kind: "MembershipRowLock", value: command.membershipId },
        {
          kind: "PersonAuthorizationLock",
          value: `vektorprogrammet:person-authorization:v1:${canonicalPersonId}`,
        },
        { kind: "MembershipUpdate", value: command.membershipId },
      ]);
    }
  }),
);
