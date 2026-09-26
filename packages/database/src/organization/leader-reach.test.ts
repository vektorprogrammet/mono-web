import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  DepartmentId,
  Organization,
  OrganizationLifecycleCommand,
  PersonId,
} from "@vektorprogrammet/domain/organization";
import { Database } from "../service.js";
import { DatabaseTestLive } from "../test-support/platform.js";
import { OrganizationLive } from "./postgres-layer.js";
import { ProfileLive } from "../profile/postgres-layer.js";

// O8-11: an ordinary team's leader acts within the team. Before the cutover every team leader
// administered the whole department; these checks fail on that rule.

const suiteLayer = ProfileLive.pipe(
  Layer.provideMerge(OrganizationLive.pipe(Layer.provideMerge(DatabaseTestLive()))),
);

const leader = PersonId.make("reach-team-leader");

const member = PersonId.make("reach-team-member");

const neighbour = PersonId.make("reach-other-member");

const department = DepartmentId.make("reach-department");

const suiteSeed = Layer.effectDiscard(
  Database.use((sql) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO organization_departments (department_id,name,short_name,email,city)
      VALUES (${department},'Reach','RCH','reach@example.invalid','Trondheim')`;
      yield* sql`INSERT INTO organization_teams (team_id,department_id,name) VALUES
      ('reach-team-own',${department},'Own team'),
      ('reach-team-other',${department},'Other team')`;
      yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name) VALUES
      (${leader},'Team','Leader'), (${member},'Team','Member'), (${neighbour},'Other','Member')`;
      yield* sql`INSERT INTO person_contact_profiles (person_id,email,phone) VALUES
      (${leader},'leader@example.invalid','12345678')`;
      yield* sql`INSERT INTO auth."user" (id,name,email,"emailVerified")
      VALUES (${leader},'Team Leader','leader@example.invalid',true)`;
      yield* sql`INSERT INTO organization_memberships
      (membership_id,person_id,team_id,start_at,end_at,is_team_leader,is_suspended) VALUES
      ('reach-leader','reach-team-leader','reach-team-own','2020-01-01',NULL,true,false),
      ('reach-member','reach-team-member','reach-team-own','2020-01-01',NULL,false,false),
      ('reach-neighbour','reach-other-member','reach-team-other','2020-01-01',NULL,false,false)`;
      yield* sql`INSERT INTO admission_period_semesters (semester_id,start_at,end_at)
      VALUES ('reach-semester','2020-01-01','2100-01-01')`;
    }),
  ),
);

const appoint = (commandId: string, personId: PersonId, teamId: string) =>
  Organization.use((organization) =>
    organization.executeLifecycle(
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
      leader,
    ),
  );

layer(suiteSeed.pipe(Layer.provideMerge(suiteLayer)), {
  excludeTestServices: true,
  timeout: "30 seconds",
})((it) => {
  it.effect(
    "lets a team leader appoint within the own team and nowhere else in the department",
    () =>
      Effect.gen(function* () {
        const own = yield* appoint("reach-appoint-own", neighbour, "reach-team-own");

        expect(own.commandId).toBe("reach-appoint-own");

        const other = yield* Effect.flip(
          appoint("reach-appoint-other", member, "reach-team-other"),
        );

        expect(other).toHaveProperty("_tag", "OrganizationLifecycleFailure");
        expect(other).toHaveProperty("code", "Denied");
      }),
  );

  it.effect("gives a team leader no department-wide mailing recipients", () =>
    Effect.gen(function* () {
      const denied = yield* Effect.flip(
        Organization.use((organization) =>
          organization.projectMailingLists({
            actorPersonId: leader,
            authorizationInstant: "2030-06-01T00:00:00.000Z",
            type: "team",
            departmentId: department,
          }),
        ),
      );

      expect(denied).toHaveProperty("_tag", "OrganizationRoleDenied");
    }),
  );
});
