import { describe, expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { PersonId, TeamId } from "@vektorprogrammet/domain/organization";
import {
  TeamApplicationAccessDenied,
  TeamApplicationCommandId,
  TeamApplicationInvalidCursor,
  TeamApplications,
  type TeamApplicationInput,
  type TeamApplicationIntake,
} from "@vektorprogrammet/domain/team-application";
import { DatabaseTestLive } from "../test-support/platform.js";
import { Database } from "../service.js";
import { TeamApplicationsLive } from "./index.js";

const database = DatabaseTestLive();

const seedTeams = Layer.effectDiscard(
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO organization_departments (department_id, name, short_name, email, city, active)
          VALUES
            ('ta-department', 'Trondheim', 'NTNU', 'department@example.invalid', 'Trondheim', true),
            ('ta-dormant-department', 'Bergen', 'UIB', 'dormant@example.invalid', 'Bergen', false)
        `;
        yield* sql`
          INSERT INTO organization_teams
            (team_id, department_id, name, email, accept_application, deadline, active)
          VALUES
            ('ta-open', 'ta-department', 'IT', 'it@example.invalid', true, NULL, true),
            ('ta-department-mailbox', 'ta-department', 'Skole', NULL, true, '2099-01-01T00:00:00Z', true),
            ('ta-closed', 'ta-department', 'Lukket', NULL, false, NULL, true),
            ('ta-undecided', 'ta-department', 'Uavklart', NULL, NULL, NULL, true),
            ('ta-expired', 'ta-department', 'Utløpt', NULL, true, '2020-01-01T00:00:00Z', true),
            ('ta-inactive', 'ta-department', 'Nedlagt', NULL, true, NULL, false),
            ('ta-dormant', 'ta-dormant-department', 'Sovende', NULL, true, NULL, true),
            ('ta-broken-mailbox', 'ta-department', 'Ødelagt', 'not a mailbox', true, NULL, true),
            ('ta-paged', 'ta-department', 'Mange', NULL, true, NULL, true),
            ('ta-revise', 'ta-department', 'Revisjon', NULL, true, NULL, true),
            ('ta-other', 'ta-department', 'Annet', NULL, true, NULL, true)
        `;
        yield* sql`
          INSERT INTO person_profiles (person_id, first_name, last_name)
          VALUES
            ('ta-leader', 'Lea', 'Leder'), ('ta-member', 'Mia', 'Medlem'),
            ('ta-former', 'Frida', 'Tidligere'), ('ta-suspended', 'Sara', 'Suspendert'),
            ('ta-outsider', 'Ola', 'Utenfor'), ('ta-admin', 'Ada', 'Admin')
        `;
        yield* sql`
          INSERT INTO organization_memberships
            (membership_id, person_id, team_id, start_at, end_at, is_team_leader, is_suspended)
          VALUES
            ('ta-m-leader', 'ta-leader', 'ta-open', '2020-01-01', NULL, true, false),
            ('ta-m-member', 'ta-member', 'ta-open', '2020-01-01', NULL, false, false),
            ('ta-m-former', 'ta-former', 'ta-open', '2020-01-01', '2021-01-01', true, false),
            ('ta-m-suspended', 'ta-suspended', 'ta-open', '2020-01-01', NULL, true, true),
            ('ta-m-outsider', 'ta-outsider', 'ta-other', '2020-01-01', NULL, true, false),
            ('ta-m-paged', 'ta-leader', 'ta-paged', '2020-01-01', NULL, false, false),
            ('ta-m-revise-leader', 'ta-leader', 'ta-revise', '2020-01-01', NULL, true, false),
            ('ta-m-revise-member', 'ta-member', 'ta-revise', '2020-01-01', NULL, false, false)
        `;
        yield* sql`
          INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at)
          VALUES ('ta-admin-grant', 'ta-admin', '2020-01-01')
        `;
      }),
    ),
  ),
);

// The seeded teams, people, and memberships are part of the suite database.
const teamApplicationsLayer = seedTeams.pipe(
  Layer.provideMerge(Layer.merge(database, TeamApplicationsLive().pipe(Layer.provide(database)))),
);

const input: TeamApplicationInput = {
  name: "Ada Søker",
  email: "ada@example.invalid",
  phone: "+47 900 00 000",
  yearOfStudy: "2. klasse",
  fieldOfStudy: "Informatikk",
  biography: "Liker å programmere.\nOg å lære bort.",
  motivation: "Vil hjelpe elever med matematikk.",
};

const teamId = (value: string) => TeamId.make(value);

const commandId = (value: string) => TeamApplicationCommandId.make(value);

const principal = (person: string) =>
  Effect.map(DateTime.now, (now) => ({
    personId: PersonId.make(person),
    authorizationInstant: DateTime.formatIso(now),
  }));

const inTransaction = <A, E>(effect: Effect.Effect<A, E, Database | TeamApplications>) =>
  Database.use((sql) => sql.withTransaction(effect));

const submit = (team: string, command: string, application: TeamApplicationInput = input) =>
  inTransaction(
    TeamApplications.use((service) =>
      service.submit({ commandId: commandId(command), teamId: teamId(team), application }),
    ),
  );

const count = (query: string) =>
  Database.use((sql) =>
    sql.unsafe<{ readonly count: number }>(`SELECT count(*)::integer AS count ${query}`),
  ).pipe(Effect.map((rows) => rows[0]?.count));

const failureTag = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E, Database | TeamApplications>,
) => Effect.map(Effect.flip(effect), (error) => error._tag);

layer(teamApplicationsLayer, { excludeTestServices: true, timeout: "30 seconds" })(
  "team applications",
  (it) => {
    describe("team application submission", () => {
      it.effect("commits the application, its receipt, and both mailbox envelopes together", () =>
        Effect.gen(function* () {
          const submitted = yield* submit("ta-open", "submit-open");
          const applicationId = submitted.confirmation.applicationId;

          expect(submitted.replayed).toBe(false);

          const outbox = yield* Database.use(
            (sql) => sql<{
              readonly effectType: string;
              readonly status: string;
              readonly envelope: {
                readonly recipient: string;
                readonly replyTo: string;
                readonly text: string;
              };
            }>`
              SELECT effect_type AS "effectType", status, payload_json AS envelope
              FROM team_application_outbox WHERE application_id = ${applicationId} ORDER BY ordinal
            `,
          );

          expect(outbox.map(({ effectType, status }) => [effectType, status])).toEqual([
            ["SendTeamApplicationReceipt", "Pending"],
            ["NotifyTeamOfApplication", "Pending"],
          ]);
          expect(outbox[0]?.envelope).toMatchObject({
            recipient: input.email,
            replyTo: "it@example.invalid",
          });
          expect(outbox[1]?.envelope).toMatchObject({
            recipient: "it@example.invalid",
            replyTo: input.email,
          });
          expect(outbox[1]?.envelope.text).toContain(input.biography);

          const fallback = yield* submit("ta-department-mailbox", "submit-fallback");

          expect(
            yield* count(
              `FROM team_application_outbox WHERE application_id = '${fallback.confirmation.applicationId}'
                AND payload_json ->> 'recipient' IN ('${input.email}', 'department@example.invalid')
                AND payload_json ->> 'replyTo' IN ('${input.email}', 'department@example.invalid')`,
            ),
          ).toBe(2);

          const rolledBack = yield* Effect.exit(
            Database.use((sql) =>
              sql.withTransaction(
                TeamApplications.use((service) =>
                  service.submit({
                    commandId: commandId("submit-rolled-back"),
                    teamId: teamId("ta-open"),
                    application: input,
                  }),
                ).pipe(Effect.andThen(Effect.fail("caller receipt failed"))),
              ),
            ),
          );

          expect(rolledBack._tag).toBe("Failure");
          expect(
            yield* count(
              `FROM team_application_command_receipts WHERE command_id = 'submit-rolled-back'`,
            ),
          ).toBe(0);
          expect(
            yield* count(`FROM team_application_outbox WHERE command_id = 'submit-rolled-back'`),
          ).toBe(0);
        }),
      );

      it.effect(
        "replays one command, rejects a changed request, and keeps distinct submissions",
        () =>
          Effect.gen(function* () {
            const before = yield* count(`FROM team_applications WHERE team_id = 'ta-other'`);
            const first = yield* submit("ta-other", "submit-replay");
            const replay = yield* submit("ta-other", "submit-replay");

            expect(replay).toEqual({ confirmation: first.confirmation, replayed: true });

            expect(
              yield* failureTag(
                submit("ta-other", "submit-replay", { ...input, name: "Changed Name" }),
              ),
            ).toBe("TeamApplicationCommandConflict");

            const second = yield* submit("ta-other", "submit-second");

            expect(second.confirmation.applicationId).not.toBe(first.confirmation.applicationId);
            expect(yield* count(`FROM team_applications WHERE team_id = 'ta-other'`)).toBe(
              (before ?? 0) + 2,
            );
            expect(
              yield* count(
                `FROM team_application_outbox WHERE command_id IN ('submit-replay', 'submit-second')`,
              ),
            ).toBe(4);
          }),
      );

      it.effect("rejects closed, expired, inactive, and unknown teams without writes", () =>
        Effect.gen(function* () {
          const rejected = [
            ["ta-closed", "TeamApplicationIntakeClosed"],
            ["ta-undecided", "TeamApplicationIntakeClosed"],
            ["ta-expired", "TeamApplicationIntakeClosed"],
            ["ta-inactive", "TeamApplicationTeamNotFound"],
            ["ta-dormant", "TeamApplicationTeamNotFound"],
            ["ta-unknown", "TeamApplicationTeamNotFound"],
            ["ta-broken-mailbox", "TeamApplicationIntakeClosed"],
          ] as const;

          for (const [team, tag] of rejected) {
            expect(yield* failureTag(submit(team, `rejected-${team}`))).toBe(tag);
          }

          const teams = rejected.map(([team]) => `'${team}'`).join(", ");

          expect(yield* count(`FROM team_applications WHERE team_id IN (${teams})`)).toBe(0);
          expect(
            yield* count(`FROM team_application_command_receipts WHERE team_id IN (${teams})`),
          ).toBe(0);
          expect(yield* count(`FROM team_application_outbox WHERE team_id IN (${teams})`)).toBe(0);
        }),
      );

      it.effect("reports intake open only where submission can reach a mailbox", () =>
        Effect.gen(function* () {
          const intakes = yield* TeamApplications.use((service) => service.listPublicIntakes);

          const listed = (team: string) => intakes.find((intake) => intake.teamId === team)?.open;

          const read = (team: string) =>
            TeamApplications.use((service) => service.readPublicIntake(teamId(team))).pipe(
              Effect.map((intake) => intake.open),
            );

          // The team mailbox is not deliverable, so no read may advertise what submit refuses.
          expect(listed("ta-broken-mailbox")).toBe(false);
          expect(yield* read("ta-broken-mailbox")).toBe(false);
          // A team without its own mailbox uses the department mailbox and stays open.
          expect(listed("ta-department-mailbox")).toBe(true);
          expect(yield* read("ta-department-mailbox")).toBe(true);
        }),
      );
    });

    describe("team application staff authority", () => {
      it.effect(
        "admits current members and denies other teams, former, suspended, and administrators",
        () =>
          Effect.gen(function* () {
            const { confirmation } = yield* submit("ta-open", "submit-staff");

            const list = (person: string) =>
              Effect.flatMap(principal(person), (actor) =>
                TeamApplications.use((service) =>
                  service.listApplications(actor, teamId("ta-open")),
                ),
              );

            const read = (person: string) =>
              Effect.flatMap(principal(person), (actor) =>
                TeamApplications.use((service) =>
                  service.readApplication(actor, confirmation.applicationId),
                ),
              );

            const leaderPage = yield* list("ta-leader");

            expect(leaderPage.actor._tag).toBe("TeamLeader");
            expect(leaderPage.intake).toMatchObject({ acceptApplication: true, open: true });
            expect(leaderPage.items.map((item) => item.applicationId)).toContain(
              confirmation.applicationId,
            );

            const memberView = yield* read("ta-member");

            expect(memberView.actor._tag).toBe("TeamMember");
            expect(memberView.application).toMatchObject({ ...input, teamId: "ta-open" });

            for (const [person, reason] of [
              ["ta-outsider", "NotInScope"],
              ["ta-former", "AuthorityInactive"],
              ["ta-suspended", "AuthorityInactive"],
              ["ta-admin", "NotInScope"],
            ] as const) {
              const denied = new TeamApplicationAccessDenied({ reason });

              expect(yield* Effect.flip(list(person))).toEqual(denied);
              expect(yield* Effect.flip(read(person))).toEqual(denied);
            }
          }),
      );

      it.effect("pages newest first without gaps or repeats", () =>
        Effect.gen(function* () {
          for (let index = 0; index < 51; index += 1) {
            yield* submit("ta-paged", `submit-paged-${index}`);
          }

          const page = (cursor?: string) =>
            Effect.flatMap(principal("ta-leader"), (actor) =>
              TeamApplications.use((service) =>
                service.listApplications(actor, teamId("ta-paged"), cursor),
              ),
            );

          const first = yield* page();
          const second = yield* page(first.nextCursor);
          const items = [...first.items, ...second.items];

          expect(first.items).toHaveLength(50);
          expect(second.items).toHaveLength(1);
          expect(second.nextCursor).toBeUndefined();
          expect(new Set(items.map((item) => item.applicationId)).size).toBe(51);
          expect(items.map((item) => item.submittedAt)).toEqual(
            items
              .map((item) => item.submittedAt)
              .toSorted()
              .toReversed(),
          );
          expect(yield* Effect.flip(page("not-a-cursor!"))).toEqual(
            new TeamApplicationInvalidCursor(),
          );
        }),
      );
    });

    describe("team application deletion", () => {
      it.effect("denies a member without changes and lets the leader remove private fields", () =>
        Effect.gen(function* () {
          const { confirmation } = yield* submit("ta-open", "submit-delete");
          const applicationId = confirmation.applicationId;

          const remove = (person: string, command: string) =>
            Effect.flatMap(principal(person), (actor) =>
              inTransaction(
                TeamApplications.use((service) =>
                  service.deleteApplication(
                    { commandId: commandId(command), applicationId },
                    actor,
                  ),
                ),
              ),
            );

          expect(yield* Effect.flip(remove("ta-member", "delete-by-member"))).toEqual(
            new TeamApplicationAccessDenied({ reason: "NotLeader" }),
          );
          expect(
            yield* count(`FROM team_applications WHERE application_id = '${applicationId}'`),
          ).toBe(1);
          expect(
            yield* count(
              `FROM team_application_outbox WHERE application_id = '${applicationId}'
                AND status = 'Pending' AND payload_json <> '{}'::jsonb`,
            ),
          ).toBe(2);
          expect(
            yield* count(`FROM team_application_audit WHERE application_id = '${applicationId}'`),
          ).toBe(0);

          yield* remove("ta-leader", "delete-by-leader");
          yield* remove("ta-leader", "delete-by-leader");

          expect(
            yield* count(`FROM team_applications WHERE application_id = '${applicationId}'`),
          ).toBe(0);
          expect(
            yield* count(
              `FROM team_application_outbox WHERE application_id = '${applicationId}'
                AND status = 'Cancelled' AND payload_json = '{}'::jsonb`,
            ),
          ).toBe(2);
          expect(
            yield* count(
              `FROM team_application_audit WHERE application_id = '${applicationId}'
                AND action = 'TeamApplicationDeleted' AND actor_person_id = 'ta-leader'`,
            ),
          ).toBe(1);
          expect(yield* failureTag(remove("ta-leader", "delete-again"))).toBe(
            "TeamApplicationNotFound",
          );
        }),
      );
    });

    describe("team application intake revision", () => {
      const intake = () =>
        Effect.flatMap(principal("ta-leader"), (actor) =>
          TeamApplications.use((service) => service.listApplications(actor, teamId("ta-revise"))),
        ).pipe(Effect.map((page) => page.intake));

      const revise = (
        person: string,
        command: string,
        check: (current: TeamApplicationIntake) => Effect.Effect<void, string>,
      ) =>
        Effect.flatMap(principal(person), (actor) =>
          inTransaction(
            TeamApplications.use((service) =>
              service.reviseIntake(
                {
                  commandId: commandId(command),
                  teamId: teamId("ta-revise"),
                  acceptApplication: false,
                  deadline: "2099-06-01T00:00:00+02:00",
                },
                actor,
                check,
              ),
            ),
          ),
        );

      it.effect("changes nothing for a stale precondition or a member", () =>
        Effect.gen(function* () {
          const before = yield* intake();

          expect(
            yield* Effect.flip(revise("ta-leader", "revise-stale", () => Effect.fail("stale"))),
          ).toBe("stale");
          expect(
            yield* Effect.flip(revise("ta-member", "revise-member", () => Effect.void)),
          ).toEqual(new TeamApplicationAccessDenied({ reason: "NotLeader" }));
          expect(yield* intake()).toEqual(before);
          expect(yield* count(`FROM team_application_audit WHERE team_id = 'ta-revise'`)).toBe(0);
        }),
      );

      it.effect("closes intake at the observed revision and audits settings, not applicants", () =>
        Effect.gen(function* () {
          const before = yield* intake();
          let observed: TeamApplicationIntake | undefined;

          const revised = yield* revise("ta-leader", "revise-close", (current) =>
            Effect.sync(() => void (observed = current)),
          );

          expect(observed).toEqual(before);
          expect(revised.intake).toEqual({
            acceptApplication: false,
            deadline: "2099-05-31T22:00:00.000Z",
            revision: before.revision + 1,
            open: false,
          });
          expect(yield* intake()).toEqual(revised.intake);

          const audit = yield* Database.use(
            (sql) => sql<{ readonly row: string }>`
              SELECT to_jsonb(audit)::text AS row FROM team_application_audit AS audit
            `,
          );

          expect(audit.length).toBeGreaterThanOrEqual(2);

          for (const { row } of audit) {
            for (const value of Object.values(input)) expect(row).not.toContain(value);
          }
        }),
      );
    });
  },
);
