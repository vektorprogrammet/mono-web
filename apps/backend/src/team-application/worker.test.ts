import { Database } from "@vektorprogrammet/database";
import { TeamApplicationsLive } from "@vektorprogrammet/database/team-application";
import { Mail, type MailDeliveryRequest } from "@vektorprogrammet/domain/mail";
import { TeamId } from "@vektorprogrammet/domain/organization";
import {
  TeamApplicationCommandId,
  TeamApplicationOutboxDelivery,
  TeamApplications,
} from "@vektorprogrammet/domain/team-application";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { backendDatabase } from "../../test/database.js";
import { drainTeamApplicationOutbox, runTeamApplicationDeliveryWorker } from "./worker.js";

const sender = "noreply@example.invalid";

const application = {
  name: "Ada Søker",
  email: "ada@example.invalid",
  phone: "+47 900 00 000",
  yearOfStudy: "2. klasse",
  fieldOfStudy: "Informatikk",
  biography: "Liker å programmere.",
  motivation: "Vil hjelpe elever.",
};

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

/** One backend process on its own PostgreSQL database: the services of both triggers. */
const fixture = () => {
  const database = backendDatabase(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO organization_departments (department_id, name, short_name, email, city)
          VALUES ('worker-department', 'Trondheim', 'NTNU', 'department@example.invalid', 'Trondheim')
        `;
        yield* sql`
          INSERT INTO organization_teams (team_id, department_id, name, email, accept_application, active)
          VALUES ('worker-open', 'worker-department', 'IT', 'it@example.invalid', true, true)
        `;
      }),
    ),
  );

  return Layer.merge(
    database.layer,
    TeamApplicationsLive({ pollInterval: "20 millis" }).pipe(Layer.provide(database.layer)),
  );
};

const submit = (command: string) =>
  Database.use((sql) =>
    sql.withTransaction(
      TeamApplications.use((service) =>
        service.submit({
          commandId: TeamApplicationCommandId.make(command),
          teamId: TeamId.make("worker-open"),
          application,
        }),
      ),
    ),
  );

const drain = (limit: number, deliveries: Array<MailDeliveryRequest>) =>
  drainTeamApplicationOutbox(sender, { limit, idle: Duration.millis(500) }).pipe(
    Effect.provide(recordingMail(deliveries)),
  );

const queueRows = Database.use(
  (sql) => sql<{
    readonly id: string;
    readonly state: string;
    readonly attempts: number;
    readonly acquiredBy: string | null;
  }>`
    SELECT id, state, attempts, acquired_by AS "acquiredBy"
    FROM effect_queue WHERE queue_name = 'team-application-notification'
    ORDER BY sequence
  `,
);

const delivered = (...effectIds: ReadonlyArray<string>) =>
  effectIds.map((effectId) => TeamApplicationOutboxDelivery.Delivered({ effectId }));

describe("team application delivery triggers", () => {
  it.live("drains at most its limit and stops when nothing was taken within the idle wait", () =>
    Effect.gen(function* () {
      yield* submit("drain-first");
      yield* submit("drain-second");

      const deliveries: Array<MailDeliveryRequest> = [];

      expect(yield* drain(3, deliveries)).toEqual(
        delivered(
          "drain-first:SendTeamApplicationReceipt",
          "drain-first:NotifyTeamOfApplication",
          "drain-second:SendTeamApplicationReceipt",
        ),
      );
      expect(yield* drain(3, deliveries)).toEqual(
        delivered("drain-second:NotifyTeamOfApplication"),
      );

      const [idle, outcomes] = yield* Effect.timed(drain(3, deliveries));

      expect(outcomes).toEqual([]);
      expect(Duration.toMillis(idle)).toBeGreaterThanOrEqual(490);
      expect(deliveries).toHaveLength(4);
      expect(yield* queueRows).toEqual(
        Array.from({ length: 4 }, () =>
          expect.objectContaining({ state: "completed", attempts: 1, acquiredBy: null }),
        ),
      );
    }).pipe(Effect.provide(fixture())),
  );

  it.live("removes completed queue items past their retention after a drain", () =>
    Effect.gen(function* () {
      yield* Database.use(
        (sql) => sql`
          INSERT INTO effect_queue
            (id, queue_name, element, state, attempts, visible_at, created_at, updated_at)
          SELECT id, 'team-application-notification', json_build_object('effectId', id)::text,
            'completed', 1, now() - age, now() - age, now() - age
          FROM (VALUES
            ('retired:SendTeamApplicationReceipt', interval '744 hours'),
            ('retained:SendTeamApplicationReceipt', interval '696 hours')
          ) AS item (id, age)
        `,
      );

      expect(yield* drain(1, [])).toEqual([]);
      expect((yield* queueRows).map(({ id }) => id)).toEqual([
        "retained:SendTeamApplicationReceipt",
      ]);
    }).pipe(Effect.provide(fixture())),
  );

  it.live("releases the attempt in flight uncounted when the resident worker is interrupted", () =>
    Effect.gen(function* () {
      yield* submit("interrupted");

      const called = yield* Deferred.make<void>();

      const stalledMail = Layer.succeed(
        Mail,
        Mail.of({
          deliver: () =>
            Deferred.succeed(called, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.as({ providerReference: "never" }),
            ),
        }),
      );

      const worker = yield* Effect.forkChild(
        runTeamApplicationDeliveryWorker(sender).pipe(Effect.provide(stalledMail)),
      );

      yield* Deferred.await(called);
      expect(yield* queueRows).toEqual([
        expect.objectContaining({ id: "interrupted:SendTeamApplicationReceipt", attempts: 1 }),
        expect.objectContaining({ id: "interrupted:NotifyTeamOfApplication", attempts: 0 }),
      ]);
      expect((yield* queueRows)[0]?.acquiredBy).not.toBeNull();

      yield* Fiber.interrupt(worker);

      expect(yield* queueRows).toEqual([
        expect.objectContaining({ state: "pending", attempts: 0, acquiredBy: null }),
        expect.objectContaining({ state: "pending", attempts: 0, acquiredBy: null }),
      ]);

      const deliveries: Array<MailDeliveryRequest> = [];

      expect(yield* drain(5, deliveries)).toEqual(
        delivered("interrupted:SendTeamApplicationReceipt", "interrupted:NotifyTeamOfApplication"),
      );
      expect(yield* queueRows).toEqual(
        Array.from({ length: 2 }, () =>
          expect.objectContaining({ state: "completed", attempts: 1, acquiredBy: null }),
        ),
      );
    }).pipe(Effect.provide(fixture())),
  );
});
