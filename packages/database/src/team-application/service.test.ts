import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime, Predicate } from "effect";
import { Mail, MailDeliveryError, type MailDeliveryRequest } from "@vektorprogrammet/domain/mail";
import { PersonId, TeamId } from "@vektorprogrammet/domain/organization";
import {
  TeamApplicationAccessDenied,
  TeamApplicationCommandId,
  TeamApplicationId,
  TeamApplicationInvalidCursor,
  TeamApplicationOutboxDelivery,
  TeamApplications,
  type TeamApplicationInput,
  type TeamApplicationIntake,
} from "@vektorprogrammet/domain/team-application";
import { DatabaseTest } from "../layers.js";
import { Database } from "../service.js";
import { TeamApplicationsLive } from "./index.js";

const database = DatabaseTest();

const runtime = ManagedRuntime.make(
  Layer.merge(database, TeamApplicationsLive.pipe(Layer.provide(database))),
);

afterAll(() => runtime.dispose());

const input: TeamApplicationInput = {
  name: "Ada Søker",
  email: "ada@example.invalid",
  phone: "+47 900 00 000",
  yearOfStudy: "2. klasse",
  fieldOfStudy: "Informatikk",
  biography: "Liker å programmere.\nOg å lære bort.",
  motivation: "Vil hjelpe elever med matematikk.",
};

const teamId = TeamId.make;

const commandId = TeamApplicationCommandId.make;

const principal = (person: string) => ({
  personId: PersonId.make(person),
  authorizationInstant: new Date().toISOString(),
});

const inTransaction = <A, E>(effect: Effect.Effect<A, E, Database | TeamApplications>) =>
  Database.use((sql) => sql.withTransaction(effect));

const submit = (team: string, command: string, application: TeamApplicationInput = input) =>
  inTransaction(
    TeamApplications.use((service) =>
      service.submit({ commandId: commandId(command), teamId: teamId(team), application }),
    ),
  );

const count = (query: string) =>
  runtime
    .runPromise(
      Database.use((sql) =>
        sql.unsafe<{ readonly count: number }>(`SELECT count(*)::integer AS count ${query}`),
      ),
    )
    .then((rows) => rows[0]?.count);

const failureTag = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E, Database | TeamApplications>,
) => runtime.runPromise(Effect.flip(effect)).then((error) => error._tag);

const recordingMail = (deliveries: Array<MailDeliveryRequest>) =>
  Layer.succeed(
    Mail,
    Mail.of({
      deliver: (request) =>
        Effect.sync(() => {
          deliveries.push(request);

          return { providerReference: `recorded:${request.deliveryId}` };
        }),
    }),
  );

const unavailableMail = Layer.succeed(
  Mail,
  Mail.of({
    deliver: () => Effect.fail(new MailDeliveryError({ kind: "temporary-unavailability" })),
  }),
);

const deliverNext = (mail: Layer.Layer<Mail>) =>
  runtime.runPromise(
    TeamApplications.use((service) =>
      service.deliverNextOutboxEffect(crypto.randomUUID(), "noreply@example.invalid"),
    ).pipe(Effect.provide(mail)),
  );

beforeAll(() =>
  runtime.runPromise(
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
  ),
);

describe("team application submission", () => {
  it("commits the application, its receipt, and both mailbox envelopes together", async () => {
    const submitted = await runtime.runPromise(submit("ta-open", "submit-open"));
    const applicationId = submitted.confirmation.applicationId;

    expect(submitted.replayed).toBe(false);

    const outbox = await runtime.runPromise(
      Database.use(
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
      ),
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

    const fallback = await runtime.runPromise(submit("ta-department-mailbox", "submit-fallback"));

    await expect(
      count(
        `FROM team_application_outbox WHERE application_id = '${fallback.confirmation.applicationId}'
          AND payload_json ->> 'recipient' IN ('${input.email}', 'department@example.invalid')
          AND payload_json ->> 'replyTo' IN ('${input.email}', 'department@example.invalid')`,
      ),
    ).resolves.toBe(2);

    const rolledBack = await runtime.runPromiseExit(
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
    await expect(
      count(`FROM team_application_command_receipts WHERE command_id = 'submit-rolled-back'`),
    ).resolves.toBe(0);
    await expect(
      count(`FROM team_application_outbox WHERE command_id = 'submit-rolled-back'`),
    ).resolves.toBe(0);
  });

  it("replays one command, rejects a changed request, and keeps distinct submissions", async () => {
    const before = await count(`FROM team_applications WHERE team_id = 'ta-other'`);
    const first = await runtime.runPromise(submit("ta-other", "submit-replay"));
    const replay = await runtime.runPromise(submit("ta-other", "submit-replay"));

    expect(replay).toEqual({ confirmation: first.confirmation, replayed: true });

    await expect(
      failureTag(submit("ta-other", "submit-replay", { ...input, name: "Changed Name" })),
    ).resolves.toBe("TeamApplicationCommandConflict");

    const second = await runtime.runPromise(submit("ta-other", "submit-second"));

    expect(second.confirmation.applicationId).not.toBe(first.confirmation.applicationId);
    await expect(count(`FROM team_applications WHERE team_id = 'ta-other'`)).resolves.toBe(
      (before ?? 0) + 2,
    );
    await expect(
      count(`FROM team_application_outbox WHERE command_id IN ('submit-replay', 'submit-second')`),
    ).resolves.toBe(4);
  });

  it("rejects closed, expired, inactive, and unknown teams without writes", async () => {
    const rejected = [
      ["ta-closed", "TeamApplicationIntakeClosed"],
      ["ta-undecided", "TeamApplicationIntakeClosed"],
      ["ta-expired", "TeamApplicationIntakeClosed"],
      ["ta-inactive", "TeamApplicationTeamNotFound"],
      ["ta-dormant", "TeamApplicationTeamNotFound"],
      ["ta-unknown", "TeamApplicationTeamNotFound"],
      ["ta-broken-mailbox", "TeamApplicationRecipientUnavailable"],
    ] as const;

    for (const [team, tag] of rejected) {
      await expect(failureTag(submit(team, `rejected-${team}`))).resolves.toBe(tag);
    }

    const teams = rejected.map(([team]) => `'${team}'`).join(", ");

    await expect(count(`FROM team_applications WHERE team_id IN (${teams})`)).resolves.toBe(0);
    await expect(
      count(`FROM team_application_command_receipts WHERE team_id IN (${teams})`),
    ).resolves.toBe(0);
    await expect(count(`FROM team_application_outbox WHERE team_id IN (${teams})`)).resolves.toBe(
      0,
    );
  });
});

describe("team application staff authority", () => {
  it("admits current members and denies other teams, former, suspended, and administrators", async () => {
    const { confirmation } = await runtime.runPromise(submit("ta-open", "submit-staff"));

    const list = (person: string) =>
      TeamApplications.use((service) =>
        service.listApplications(principal(person), teamId("ta-open")),
      );

    const read = (person: string) =>
      TeamApplications.use((service) =>
        service.readApplication(principal(person), confirmation.applicationId),
      );

    const leaderPage = await runtime.runPromise(list("ta-leader"));

    expect(leaderPage.actor._tag).toBe("TeamLeader");
    expect(leaderPage.intake).toMatchObject({ acceptApplication: true, open: true });
    expect(leaderPage.items.map((item) => item.applicationId)).toContain(
      confirmation.applicationId,
    );

    const memberView = await runtime.runPromise(read("ta-member"));

    expect(memberView.actor._tag).toBe("TeamMember");
    expect(memberView.application).toMatchObject({ ...input, teamId: "ta-open" });

    for (const [person, reason] of [
      ["ta-outsider", "NotInScope"],
      ["ta-former", "AuthorityInactive"],
      ["ta-suspended", "AuthorityInactive"],
      ["ta-admin", "NotInScope"],
    ] as const) {
      const denied = new TeamApplicationAccessDenied({ reason });

      await expect(runtime.runPromise(Effect.flip(list(person)))).resolves.toEqual(denied);
      await expect(runtime.runPromise(Effect.flip(read(person)))).resolves.toEqual(denied);
    }
  });

  it("pages newest first without gaps or repeats", async () => {
    for (let index = 0; index < 51; index += 1) {
      await runtime.runPromise(submit("ta-paged", `submit-paged-${index}`));
    }

    const page = (cursor?: string) =>
      runtime.runPromise(
        TeamApplications.use((service) =>
          service.listApplications(principal("ta-leader"), teamId("ta-paged"), cursor),
        ),
      );

    const first = await page();
    const second = await page(first.nextCursor);
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
    await expect(
      runtime.runPromise(
        Effect.flip(
          TeamApplications.use((service) =>
            service.listApplications(principal("ta-leader"), teamId("ta-paged"), "not-a-cursor!"),
          ),
        ),
      ),
    ).resolves.toEqual(new TeamApplicationInvalidCursor());
  });
});

describe("team application deletion", () => {
  it("denies a member without changes and lets the leader remove private fields", async () => {
    const { confirmation } = await runtime.runPromise(submit("ta-open", "submit-delete"));
    const applicationId = confirmation.applicationId;

    const remove = (person: string, command: string) =>
      inTransaction(
        TeamApplications.use((service) =>
          service.deleteApplication(
            { commandId: commandId(command), applicationId },
            principal(person),
          ),
        ),
      );

    await expect(
      runtime.runPromise(Effect.flip(remove("ta-member", "delete-by-member"))),
    ).resolves.toEqual(new TeamApplicationAccessDenied({ reason: "NotLeader" }));
    await expect(
      count(`FROM team_applications WHERE application_id = '${applicationId}'`),
    ).resolves.toBe(1);
    await expect(
      count(
        `FROM team_application_outbox WHERE application_id = '${applicationId}'
          AND status = 'Pending' AND payload_json <> '{}'::jsonb`,
      ),
    ).resolves.toBe(2);
    await expect(
      count(`FROM team_application_audit WHERE application_id = '${applicationId}'`),
    ).resolves.toBe(0);

    await runtime.runPromise(remove("ta-leader", "delete-by-leader"));
    await runtime.runPromise(remove("ta-leader", "delete-by-leader"));

    await expect(
      count(`FROM team_applications WHERE application_id = '${applicationId}'`),
    ).resolves.toBe(0);
    await expect(
      count(
        `FROM team_application_outbox WHERE application_id = '${applicationId}'
          AND status = 'Cancelled' AND payload_json = '{}'::jsonb`,
      ),
    ).resolves.toBe(2);
    await expect(
      count(
        `FROM team_application_audit WHERE application_id = '${applicationId}'
          AND action = 'TeamApplicationDeleted' AND actor_person_id = 'ta-leader'`,
      ),
    ).resolves.toBe(1);
    await expect(failureTag(remove("ta-leader", "delete-again"))).resolves.toBe(
      "TeamApplicationNotFound",
    );
  });
});

describe("team application intake revision", () => {
  const intake = () =>
    runtime
      .runPromise(
        TeamApplications.use((service) =>
          service.listApplications(principal("ta-leader"), teamId("ta-revise")),
        ),
      )
      .then((page) => page.intake);

  const revise = (
    person: string,
    command: string,
    check: (current: TeamApplicationIntake) => Effect.Effect<void, string>,
  ) =>
    inTransaction(
      TeamApplications.use((service) =>
        service.reviseIntake(
          {
            commandId: commandId(command),
            teamId: teamId("ta-revise"),
            acceptApplication: false,
            deadline: "2099-06-01T00:00:00+02:00",
          },
          principal(person),
          check,
        ),
      ),
    );

  it("changes nothing for a stale precondition or a member", async () => {
    const before = await intake();

    await expect(
      runtime.runPromise(
        Effect.flip(revise("ta-leader", "revise-stale", () => Effect.fail("stale"))),
      ),
    ).resolves.toBe("stale");
    await expect(
      runtime.runPromise(Effect.flip(revise("ta-member", "revise-member", () => Effect.void))),
    ).resolves.toEqual(new TeamApplicationAccessDenied({ reason: "NotLeader" }));
    await expect(intake()).resolves.toEqual(before);
    await expect(count(`FROM team_application_audit WHERE team_id = 'ta-revise'`)).resolves.toBe(0);
  });

  it("closes intake at the observed revision and audits settings, not applicants", async () => {
    const before = await intake();
    let observed: TeamApplicationIntake | undefined;

    const revised = await runtime.runPromise(
      revise("ta-leader", "revise-close", (current) =>
        Effect.sync(() => void (observed = current)),
      ),
    );

    expect(observed).toEqual(before);
    expect(revised.intake).toEqual({
      acceptApplication: false,
      deadline: "2099-05-31T22:00:00.000Z",
      revision: before.revision + 1,
      open: false,
    });
    await expect(intake()).resolves.toEqual(revised.intake);

    const audit = await runtime.runPromise(
      Database.use(
        (sql) => sql<{ readonly row: string }>`
          SELECT to_jsonb(audit)::text AS row FROM team_application_audit AS audit
        `,
      ),
    );

    expect(audit.length).toBeGreaterThanOrEqual(2);

    for (const { row } of audit) {
      for (const value of Object.values(input)) expect(row).not.toContain(value);
    }
  });
});

describe("team application delivery", () => {
  it("keeps the application after a provider failure and delivers the retained envelopes", async () => {
    const drained: Array<MailDeliveryRequest> = [];

    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (Predicate.isTagged(await deliverNext(recordingMail(drained)), "Idle")) break;
    }

    const { confirmation } = await runtime.runPromise(submit("ta-open", "submit-delivery"));

    await expect(deliverNext(unavailableMail)).resolves.toEqual(
      TeamApplicationOutboxDelivery.Failed({
        effectId: "submit-delivery:NotifyTeamOfApplication",
        failureTag: "MailDeliveryError:temporary-unavailability",
      }),
    );
    await expect(
      count(`FROM team_applications WHERE application_id = '${confirmation.applicationId}'`),
    ).resolves.toBe(1);
    await expect(
      count(
        `FROM team_application_outbox WHERE application_id = '${confirmation.applicationId}'
          AND status = 'Failed' AND attempts = 1 AND payload_json <> '{}'::jsonb`,
      ),
    ).resolves.toBe(1);

    const deliveries: Array<MailDeliveryRequest> = [];

    await expect(deliverNext(recordingMail(deliveries))).resolves.toEqual(
      TeamApplicationOutboxDelivery.Delivered({
        effectId: "submit-delivery:SendTeamApplicationReceipt",
      }),
    );
    await expect(deliverNext(recordingMail(deliveries))).resolves.toEqual(
      TeamApplicationOutboxDelivery.Delivered({
        effectId: "submit-delivery:NotifyTeamOfApplication",
      }),
    );
    await expect(deliverNext(recordingMail(deliveries))).resolves.toEqual(
      TeamApplicationOutboxDelivery.Idle(),
    );

    expect(
      deliveries.map(({ recipient, replyTo, sender }) => [recipient, replyTo, sender]).toSorted(),
    ).toEqual(
      [
        [input.email, "it@example.invalid", "noreply@example.invalid"],
        ["it@example.invalid", input.email, "noreply@example.invalid"],
      ].toSorted(),
    );
    await expect(
      count(
        `FROM team_application_outbox WHERE application_id = '${confirmation.applicationId}'
          AND status = 'Delivered' AND payload_json = '{}'::jsonb`,
      ),
    ).resolves.toBe(2);
  });

  it("loses an in-flight claim to deletion instead of failing, and recovers stale claims", async () => {
    const { confirmation } = await runtime.runPromise(submit("ta-open", "submit-in-flight"));

    const deletingMail = Layer.succeed(
      Mail,
      Mail.of({
        deliver: (request) =>
          Effect.promise(() =>
            runtime.runPromise(
              inTransaction(
                TeamApplications.use((service) =>
                  service.deleteApplication(
                    {
                      commandId: commandId("delete-in-flight"),
                      applicationId: TeamApplicationId.make(confirmation.applicationId),
                    },
                    principal("ta-leader"),
                  ),
                ),
              ),
            ),
          ).pipe(Effect.as({ providerReference: request.deliveryId })),
      }),
    );

    await expect(deliverNext(deletingMail)).resolves.toEqual(
      TeamApplicationOutboxDelivery.ClaimLost({
        effectId: "submit-in-flight:NotifyTeamOfApplication",
      }),
    );
    await expect(
      count(
        `FROM team_application_outbox WHERE application_id = '${confirmation.applicationId}'
          AND status = 'Cancelled' AND payload_json = '{}'::jsonb`,
      ),
    ).resolves.toBe(2);

    const stale = await runtime.runPromise(submit("ta-open", "submit-stale"));

    await runtime.runPromise(
      Database.use(
        (sql) => sql`
          UPDATE team_application_outbox SET status = 'Processing', claim_id = 'abandoned',
            claimed_at = '2020-01-01T00:00:00Z', attempts = 1
          WHERE application_id = ${stale.confirmation.applicationId} AND ordinal = 0
        `,
      ),
    );

    await expect(
      runtime.runPromise(
        TeamApplications.use((service) =>
          service.recoverStaleOutboxClaims(new Date().toISOString()),
        ),
      ),
    ).resolves.toBe(1);
    await expect(
      count(
        `FROM team_application_outbox WHERE application_id = '${stale.confirmation.applicationId}'
          AND ordinal = 0 AND status = 'Failed' AND last_failure_tag = 'StaleTeamApplicationOutboxClaim'`,
      ),
    ).resolves.toBe(1);
  });

  it("quarantines an undeliverable stored envelope and clears it without a provider call", async () => {
    const poisoned = "poisoned:SendTeamApplicationReceipt";

    await runtime.runPromise(
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO team_application_command_receipts
                (command_id, command_sha256, operation, team_id, application_id, observation_json, committed_at)
              VALUES ('poisoned', ${"a".repeat(64)}, 'SubmitTeamApplication', 'ta-open',
                '00000000-0000-4000-8000-000000000000', '{}', now())
            `;
            yield* sql`
              INSERT INTO team_application_outbox
                (effect_id, effect_type, team_id, application_id, command_id, ordinal, payload_json, committed_at)
              VALUES (${poisoned}, 'SendTeamApplicationReceipt', 'ta-open',
                '00000000-0000-4000-8000-000000000000', 'poisoned', 0,
                ${sql.json({
                  deliveryId: poisoned,
                  recipient: "not a mailbox",
                  replyTo: "it@example.invalid",
                  subject: "Søknad til IT mottatt",
                  text: "Vi har mottatt søknaden din.",
                })}, now())
            `;
          }),
        ),
      ),
    );

    const deliveries: Array<MailDeliveryRequest> = [];
    const outcomes: Array<TeamApplicationOutboxDelivery> = [];

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const outcome = await deliverNext(recordingMail(deliveries));

      if (Predicate.isTagged(outcome, "Idle")) break;
      outcomes.push(outcome);
    }

    expect(outcomes).toContainEqual(
      TeamApplicationOutboxDelivery.Quarantined({
        effectId: poisoned,
        failureTag: "InvalidTeamApplicationEnvelope",
      }),
    );
    expect(deliveries.map((delivery) => delivery.deliveryId)).not.toContain(poisoned);
    await expect(
      count(
        `FROM team_application_outbox WHERE effect_id = '${poisoned}'
          AND status = 'Quarantined' AND payload_json = '{}'::jsonb`,
      ),
    ).resolves.toBe(1);
  });
});
