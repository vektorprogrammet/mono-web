import { expect, layer } from "@effect/vitest";
import { type DisposablePostgres, startDisposablePostgres } from "@monoweb/postgres";
import { Context, Effect, Layer, Redacted } from "effect";
import {
  DelegationArea,
  DelegationCommand,
  type DelegableCapability,
} from "@vektorprogrammet/domain/authz";
import {
  DepartmentId,
  Organization,
  OrganizationLifecycleCommand,
  PersonId,
  TeamId,
} from "@vektorprogrammet/domain/organization";
import { DatabaseLive } from "../layers.js";
import { NativeDatabaseStartupOptions } from "../search-path.js";
import { Database } from "../service.js";
import { TestPlatform } from "../test-support/platform.js";
import { OrganizationLive } from "./postgres-layer.js";

class NationalTeamCluster extends Context.Service<NationalTeamCluster, DisposablePostgres>()(
  "organization/national-team-reach-postgres.test/NationalTeamCluster",
) {}

const cluster = Layer.effect(
  NationalTeamCluster,
  Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ listen: "socket", maxConnections: 8 })),
    (postgres) => Effect.promise(() => postgres.stop()),
  ),
);

const database = Layer.unwrap(
  Effect.map(NationalTeamCluster, (postgres) =>
    DatabaseLive({
      url: Redacted.make(postgres.url),
      applicationName: "national-team-reach-postgres-test",
      maxConnections: 2,
      startupOptions: NativeDatabaseStartupOptions,
    }).pipe(Layer.provide(TestPlatform)),
  ),
);

const actors = {
  styret: PersonId.make("national-reach-styret"),
  hovedstyret: PersonId.make("national-reach-hovedstyret"),
  administrator: PersonId.make("national-reach-administrator"),
  localMember: PersonId.make("national-reach-local-member"),
  nationalMember: PersonId.make("national-reach-national-member"),
  otherNationalMember: PersonId.make("national-reach-other-national-member"),
};

const localTeam = TeamId.make("national-reach-local-team");

const nationalTeam = TeamId.make("national-reach-national-team");

const seed = Layer.effectDiscard(
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name) VALUES
        (${actors.styret},'Local','Board'),
        (${actors.hovedstyret},'National','Board'),
        (${actors.administrator},'Global','Administrator'),
        (${actors.localMember},'Local','Member'),
        (${actors.nationalMember},'National','Member'),
        (${actors.otherNationalMember},'Other','Member')`;
      yield* sql`INSERT INTO auth."user" (id,name,email,"emailVerified")
        SELECT person_id, first_name || ' ' || last_name, person_id || '@example.invalid', true
        FROM person_profiles WHERE person_id LIKE 'national-reach-%'`;
      yield* sql`INSERT INTO organization_departments
        (department_id,name,short_name,email,city,independent)
        VALUES ('national-reach-home','Home','HOME','home@example.invalid','Trondheim',true)`;
      yield* sql`INSERT INTO organization_teams (team_id,department_id,name,kind,team_scope) VALUES
        ('national-reach-board','national-reach-home','Styret','DepartmentBoard','HomeDepartment'),
        (${localTeam},'national-reach-home','Local team','Team','HomeDepartment'),
        (${nationalTeam},'national-reach-home','National team','Team','National')`;
      yield* sql`INSERT INTO organization_national_boards (board_id,name)
        VALUES ('national-reach-hs','Hovedstyret')`;
      yield* sql`INSERT INTO organization_memberships
        (membership_id,person_id,team_id,board_id,start_at,end_at,is_team_leader,is_suspended) VALUES
        ('national-reach-styret-seat',${actors.styret},'national-reach-board',NULL,'2020-01-01',NULL,true,false),
        ('national-reach-hs-seat',${actors.hovedstyret},NULL,'national-reach-hs','2020-01-01',NULL,true,false),
        ('national-reach-local-seat',${actors.localMember},${localTeam},NULL,'2020-01-01',NULL,false,false),
        ('national-reach-national-seat',${actors.nationalMember},${nationalTeam},NULL,'2020-01-01',NULL,false,false)`;
      yield* sql`INSERT INTO organization_global_administrator_grants
        (grant_id,person_id,start_at,end_at,revision)
        VALUES ('national-reach-admin-grant',${actors.administrator},'2020-01-01',NULL,0)`;
    }),
  ),
);

const organization = seed.pipe(
  Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(database))),
  Layer.provideMerge(cluster),
);

const appoint = (commandId: string, actor: PersonId, personId: PersonId, teamId: TeamId) =>
  Organization.use((service) =>
    service.executeLifecycle(
      OrganizationLifecycleCommand.cases.Appoint.make({
        commandId,
        reason: "Semesterstart",
        personId,
        target: { kind: "Team", id: teamId },
        position: null,
        leadership: false,
        startAt: "2030-01-01T00:00:00.000Z",
        endAt: null,
      }),
      actor,
    ),
  );

const issue = (
  commandId: string,
  actor: PersonId,
  teamId: TeamId,
  capability: DelegableCapability = "admissions.outcomes",
) =>
  Organization.use((service) =>
    service.executeDelegation(
      DelegationCommand.cases.IssueDelegation.make({
        commandId,
        reason: "Semesterstart",
        name: "Staffing",
        teamId,
        capability,
        area: DelegationArea.cases.Department.make({
          departmentId: DepartmentId.make("national-reach-home"),
        }),
        holders: "AllMembers",
        startAt: "2020-01-01T00:00:00.000Z",
        endAt: null,
      }),
      actor,
    ),
  );

layer(organization, { excludeTestServices: true, timeout: "90 seconds" })(
  "national team reach on real PostgreSQL",
  (it) => {
    it.effect(
      "denies a home Styret leader appointment and delegation management of a hosted national team",
      () =>
        Effect.gen(function* () {
          const denied = yield* Effect.flip(
            appoint("national-reach-denied", actors.styret, actors.nationalMember, nationalTeam),
          );

          expect(denied).toHaveProperty("_tag", "OrganizationLifecycleFailure");
          expect(denied).toHaveProperty("code", "Denied");

          const management = yield* Organization.use((service) =>
            service.readAppointmentManagement(actors.styret),
          );

          expect(management.units.some((unit) => unit.target.id === nationalTeam)).toBe(false);

          const delegations = yield* Organization.use((service) =>
            service.readDelegationManagement(actors.styret),
          );

          expect(delegations.teams.some((team) => team.teamId === nationalTeam)).toBe(false);

          const deniedDelegation = yield* Effect.flip(
            issue("national-reach-denied-delegation", actors.styret, nationalTeam),
          );

          expect(deniedDelegation).toHaveProperty("_tag", "OrganizationLifecycleFailure");
          expect(deniedDelegation).toHaveProperty("code", "Denied");
        }),
    );

    it.effect("permits the home Styret leader to appoint and manage a local team", () =>
      Effect.gen(function* () {
        const appointment = yield* appoint(
          "national-reach-local",
          actors.styret,
          actors.localMember,
          localTeam,
        );

        expect(appointment.commandId).toBe("national-reach-local");

        const delegation = yield* issue(
          "national-reach-local-delegation",
          actors.styret,
          localTeam,
        );

        expect(delegation.commandId).toBe("national-reach-local-delegation");
      }),
    );

    it.effect("permits Hovedstyret's leader and a global administrator on the national team", () =>
      Effect.gen(function* () {
        const national = yield* appoint(
          "national-reach-hs-appoint",
          actors.hovedstyret,
          actors.nationalMember,
          nationalTeam,
        );

        const global = yield* appoint(
          "national-reach-global-appoint",
          actors.administrator,
          actors.otherNationalMember,
          nationalTeam,
        );

        expect(national.commandId).toBe("national-reach-hs-appoint");
        expect(global.commandId).toBe("national-reach-global-appoint");

        const nationalDelegation = yield* issue(
          "national-reach-hs-delegation",
          actors.hovedstyret,
          nationalTeam,
        );

        const globalDelegation = yield* issue(
          "national-reach-global-delegation",
          actors.administrator,
          nationalTeam,
          "placements.coordinate",
        );

        expect(nationalDelegation.commandId).toBe("national-reach-hs-delegation");
        expect(globalDelegation.commandId).toBe("national-reach-global-delegation");
      }),
    );
  },
);
