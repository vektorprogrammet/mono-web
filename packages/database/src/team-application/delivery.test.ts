import { describe, expect, layer } from "@effect/vitest";
import {
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Predicate,
  Schema,
} from "effect";
import {
  Mail,
  MailDeliveryError,
  type MailDeliveryFailureKind,
  type MailDeliveryRequest,
} from "@vektorprogrammet/domain/mail";
import { PersonId, TeamId } from "@vektorprogrammet/domain/organization";
import {
  TeamApplicationCommandId,
  TeamApplicationEnvelope,
  TeamApplicationId,
  TeamApplicationOutboxDelivery,
  TeamApplications,
  type TeamApplicationInput,
} from "@vektorprogrammet/domain/team-application";
import { DatabaseTestLive } from "../test-support/platform.js";
import { Database } from "../service.js";
import { TeamApplicationsLive } from "./index.js";
import {
  deliverNextTeamApplicationOutbox,
  TeamApplicationDeliveryQueue,
  TeamApplicationDeliveryQueueLive,
  type TeamApplicationDeliveryOptions,
} from "./outbox.js";

/**
 * The landing conditions of the team-application PersistedQueue pilot
 * (docs/specs/infrastructure-ports.md), on PGlite. `delivery-pgbouncer.test.ts` repeats the
 * transaction condition through PgBouncer, and `queue-migration.test.ts` covers the move of
 * in-flight rows.
 */
const database = DatabaseTestLive();

const sender = "noreply@example.invalid";

/** Retries wait one second, and the third attempt is the last. */
const fastQueue = {
  pollInterval: "20 millis",
  retryDelayMax: "1 second",
  maxAttempts: 3,
} satisfies Partial<TeamApplicationDeliveryOptions>;

const seedTeam = Layer.effectDiscard(
  Database.use((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO organization_departments (department_id, name, short_name, email, city, active)
          VALUES ('pilot-department', 'Trondheim', 'NTNU', 'department@example.invalid', 'Trondheim', true)
        `;
        yield* sql`
          INSERT INTO organization_teams
            (team_id, department_id, name, email, accept_application, deadline, active)
          VALUES ('pilot-team', 'pilot-department', 'IT', 'it@example.invalid', true, NULL, true)
        `;
        yield* sql`
          INSERT INTO person_profiles (person_id, first_name, last_name)
          VALUES ('pilot-leader', 'Lea', 'Leder')
        `;
        yield* sql`
          INSERT INTO organization_memberships
            (membership_id, person_id, team_id, start_at, end_at, is_team_leader, is_suspended)
          VALUES ('pilot-m-leader', 'pilot-leader', 'pilot-team', '2020-01-01', NULL, true, false)
        `;
      }),
    ),
  ),
);

const pilotLayer = seedTeam.pipe(
  Layer.provideMerge(
    Layer.merge(database, TeamApplicationsLive(fastQueue).pipe(Layer.provide(database))),
  ),
);

const input: TeamApplicationInput = {
  name: "Ada Søker",
  email: "ada@example.invalid",
  phone: "+47 900 00 000",
  yearOfStudy: "2. klasse",
  fieldOfStudy: "Informatikk",
  biography: "Liker å programmere.",
  motivation: "Vil hjelpe elever med matematikk.",
};

const submitCommand = (command: string) =>
  TeamApplications.use((service) =>
    service.submit({
      commandId: TeamApplicationCommandId.make(command),
      teamId: TeamId.make("pilot-team"),
      application: input,
    }),
  );

const submit = (command: string) =>
  Database.use((sql) => sql.withTransaction(submitCommand(command)));

const deleteApplication = (applicationId: string, command: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;

    yield* Database.use((sql) =>
      sql.withTransaction(
        TeamApplications.use((service) =>
          service.deleteApplication(
            {
              commandId: TeamApplicationCommandId.make(command),
              applicationId: TeamApplicationId.make(applicationId),
            },
            {
              personId: PersonId.make("pilot-leader"),
              authorizationInstant: DateTime.formatIso(now),
            },
          ),
        ),
      ),
    );
  });

/** The receipt, then the team notification: the order in which a command enqueues them. */
const effects = (command: string) =>
  [`${command}:SendTeamApplicationReceipt`, `${command}:NotifyTeamOfApplication`] as const;

const count = (query: string) =>
  Database.use((sql) =>
    sql.unsafe<{ readonly count: number }>(`SELECT count(*)::integer AS count ${query}`),
  ).pipe(Effect.map((rows) => rows[0]?.count));

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

/** Records each request, then fails it with `kind`. */
const failingMail = (kind: MailDeliveryFailureKind, deliveries: Array<MailDeliveryRequest> = []) =>
  Layer.succeed(
    Mail,
    Mail.of({
      deliver: (request) =>
        Effect.sync(() => deliveries.push(request)).pipe(
          Effect.andThen(Effect.fail(new MailDeliveryError({ kind }))),
        ),
    }),
  );

/** A provider call that records its request only after the test releases it. */
const gatedMail = Effect.gen(function* () {
  const called = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const deliveries: Array<MailDeliveryRequest> = [];

  const layer = Layer.succeed(
    Mail,
    Mail.of({
      deliver: (request) =>
        Deferred.succeed(called, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            Effect.sync(() => {
              deliveries.push(request);

              return { providerReference: `gated:${request.deliveryId}` };
            }),
          ),
        ),
    }),
  );

  return {
    /** Fails when the attempt made no provider call within five seconds. */
    called: Deferred.await(called).pipe(Effect.timeout("5 seconds")),
    release: Deferred.succeed(release, undefined),
    deliveries,
    layer,
  };
});

const deliverNext = (mail: Layer.Layer<Mail>, idle: Duration.Input = "5 seconds") =>
  TeamApplications.use((service) =>
    service.deliverNextOutboxEffect(sender, Duration.fromInputUnsafe(idle)),
  ).pipe(Effect.provide(mail));

/** Delivers every due notification, so a test starts from an idle queue. */
const drain = Effect.gen(function* () {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (Predicate.isTagged(yield* deliverNext(recordingMail([]), "200 millis"), "Idle")) return;
  }

  return yield* Effect.die(new Error("team application queue did not drain"));
});

/**
 * Another delivery worker on the test database, for the scope of the test: its own queue
 * store and lease identity.
 */
const worker = (options: Partial<TeamApplicationDeliveryOptions> = {}) =>
  Layer.build(TeamApplicationDeliveryQueueLive({ ...fastQueue, ...options }));

/** One attempt of `services`' worker, with `mail` as the provider. */
const deliverAs = (
  services: Context.Context<TeamApplicationDeliveryQueue>,
  mail: Layer.Layer<Mail>,
) =>
  deliverNextTeamApplicationOutbox(sender, Duration.seconds(5)).pipe(
    Effect.provideContext(services),
    Effect.provide(mail),
  );

const QueueRow = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  attempts: Schema.Int,
  acquiredBy: Schema.NullOr(Schema.String),
  waiting: Schema.Boolean,
});

/** The queue items of one command, in commit order. */
const queueRows = (command: string) =>
  Database.use(
    (sql) => sql<typeof QueueRow.Type>`
      SELECT id, state, attempts, acquired_by AS "acquiredBy", visible_at > now() AS waiting
      FROM effect_queue
      WHERE queue_name = 'team-application-notification' AND id LIKE ${`${command}:%`}
      ORDER BY sequence
    `,
  );

/** The one delivery-state read of a command's notifications. */
const deliveryStates = (command: string) =>
  Database.use(
    (sql) => sql<{
      readonly status: string;
      readonly attempts: number;
      readonly lastFailureTag: string | null;
    }>`
      SELECT status, attempts, last_failure_tag AS "lastFailureTag"
      FROM team_application_delivery_state
      WHERE command_id = ${command}
      ORDER BY ordinal
    `,
  );

/** The stored envelopes of a command, as JSON text, in commit order. */
const storedEnvelopes = (command: string) =>
  Database.use(
    (sql) => sql<{ readonly envelope: string }>`
      SELECT payload_json::text AS envelope FROM team_application_outbox
      WHERE command_id = ${command} ORDER BY ordinal
    `,
  ).pipe(Effect.map((rows) => rows.map(({ envelope }) => envelope)));

const { Delivered, Failed, Idle, LeaseLost, Quarantined, Skipped, Superseded } =
  TeamApplicationOutboxDelivery;

const temporary = "MailDeliveryError:temporary-unavailability";

layer(pilotLayer, { excludeTestServices: true, timeout: "60 seconds" })(
  "team application delivery pilot",
  (it) => {
    describe("one transaction", () => {
      it.effect(
        "commits the application, its receipt, both envelopes, and their queue items together, or none",
        () =>
          Effect.gen(function* () {
            const [receipt, notification] = effects("atomic-commit");
            const { confirmation } = yield* submit("atomic-commit");

            expect(
              yield* count(
                `FROM team_applications WHERE application_id = '${confirmation.applicationId}'`,
              ),
            ).toBe(1);
            expect(
              yield* count(
                `FROM team_application_command_receipts WHERE command_id = 'atomic-commit'`,
              ),
            ).toBe(1);
            expect(
              yield* count(
                `FROM team_application_outbox WHERE command_id = 'atomic-commit'
                  AND status = 'Pending' AND payload_json <> '{}'::jsonb`,
              ),
            ).toBe(2);
            expect(yield* queueRows("atomic-commit")).toEqual(
              [receipt, notification].map((id) => ({
                id,
                state: "pending",
                attempts: 0,
                acquiredBy: null,
                waiting: false,
              })),
            );
            // The queue item names the effect; the private envelope stays in the outbox row.
            expect(
              yield* count(
                `FROM effect_queue WHERE id LIKE 'atomic-commit:%' AND element LIKE '%${input.email}%'`,
              ),
            ).toBe(0);

            const rolledBack = yield* Effect.exit(
              Database.use((sql) =>
                sql.withTransaction(
                  submitCommand("atomic-rollback").pipe(
                    Effect.andThen(Effect.fail("caller receipt failed")),
                  ),
                ),
              ),
            );

            expect(rolledBack._tag).toBe("Failure");
            expect(
              yield* count(
                `FROM team_application_command_receipts WHERE command_id = 'atomic-rollback'`,
              ),
            ).toBe(0);
            expect(yield* count(`FROM team_applications WHERE team_id = 'pilot-team'`)).toBe(1);
            expect(
              yield* count(`FROM team_application_outbox WHERE command_id = 'atomic-rollback'`),
            ).toBe(0);
            expect(yield* queueRows("atomic-rollback")).toEqual([]);
          }),
      );
    });

    describe("lease", () => {
      it.effect(
        "reclaims an expired lease for another worker and rejects the late former owner's outcome",
        () =>
          Effect.gen(function* () {
            yield* drain;
            yield* submit("lease-other");

            const [receipt, notification] = effects("lease-other");
            // A worker that stopped refreshing its lease, as a process paused past the expiry.
            // The taking worker judges expiry by its own lock expiration.
            const stalled = yield* worker({ lockRefreshInterval: "1 hour" });
            const successor = yield* worker({ lockExpiration: "1 second" });
            const first = yield* gatedMail;
            const second = yield* gatedMail;
            const deliveries: Array<MailDeliveryRequest> = [];

            const late = yield* Effect.forkChild(deliverAs(stalled, first.layer));

            yield* first.called;

            const [held] = yield* queueRows("lease-other");

            expect(held).toMatchObject({ id: receipt, state: "pending", attempts: 1 });
            expect(yield* deliverAs(successor, recordingMail(deliveries))).toEqual(
              Delivered({ effectId: notification }),
            );

            // The successor takes the receipt once the stalled lease is a second old.
            yield* Effect.sleep("1100 millis");

            const redelivery = yield* Effect.forkChild(deliverAs(successor, second.layer));

            yield* second.called;

            const [taken] = yield* queueRows("lease-other");

            expect(taken).toMatchObject({ id: receipt, state: "pending", attempts: 2 });
            expect(taken?.acquiredBy).not.toBe(held?.acquiredBy);

            yield* first.release;

            expect(yield* Fiber.join(late)).toEqual(LeaseLost({ effectId: receipt }));
            // The late owner recorded nothing, and the successor still holds its lease.
            expect(yield* deliveryStates("lease-other")).toEqual([
              { status: "Processing", attempts: 2, lastFailureTag: null },
              { status: "Delivered", attempts: 1, lastFailureTag: null },
            ]);
            expect((yield* queueRows("lease-other"))[0]).toEqual(taken);

            yield* second.release;

            expect(yield* Fiber.join(redelivery)).toEqual(Delivered({ effectId: receipt }));
            expect(yield* deliveryStates("lease-other")).toEqual([
              { status: "Delivered", attempts: 2, lastFailureTag: null },
              { status: "Delivered", attempts: 1, lastFailureTag: null },
            ]);
            // Both attempts of the receipt reached the provider under the same identity.
            expect(
              [...first.deliveries, ...second.deliveries].map(({ deliveryId }) => deliveryId),
            ).toEqual([receipt, receipt]);
          }).pipe(Effect.scoped),
      );

      it.effect(
        "rejects a stalled attempt's outcome after its own worker took the lease again",
        () =>
          Effect.gen(function* () {
            yield* drain;
            yield* submit("lease-own");

            const [receipt, notification] = effects("lease-own");

            // One worker whose lease expires after a second without a refresh.
            const stalling = yield* worker({
              lockExpiration: "1 second",
              lockRefreshInterval: "1 hour",
            });

            const first = yield* gatedMail;
            const second = yield* gatedMail;
            const deliveries: Array<MailDeliveryRequest> = [];
            const deliverWith = (mail: Layer.Layer<Mail>) => deliverAs(stalling, mail);
            const stalled = yield* Effect.forkChild(deliverWith(first.layer));

            yield* first.called;
            expect(yield* deliverWith(recordingMail(deliveries))).toEqual(
              Delivered({ effectId: notification }),
            );
            yield* Effect.sleep("1100 millis");

            const retaken = yield* Effect.forkChild(deliverWith(second.layer));

            yield* second.called;
            expect((yield* queueRows("lease-own"))[0]).toMatchObject({
              id: receipt,
              state: "pending",
              attempts: 2,
            });

            yield* first.release;
            expect(yield* Fiber.join(stalled)).toEqual(LeaseLost({ effectId: receipt }));
            // Nobody recorded a failure, and the retry released the item: it waits, Pending.
            expect((yield* deliveryStates("lease-own"))[0]).toEqual({
              status: "Pending",
              attempts: 2,
              lastFailureTag: null,
            });

            // The worker's store fences by worker, so the stalled failure released the lease
            // of the second attempt too; neither records, and a third attempt delivers.
            yield* second.release;
            expect(yield* Fiber.join(retaken)).toEqual(LeaseLost({ effectId: receipt }));
            expect(yield* deliverWith(recordingMail(deliveries))).toEqual(
              Delivered({ effectId: receipt }),
            );
            expect(yield* deliveryStates("lease-own")).toEqual([
              { status: "Delivered", attempts: 3, lastFailureTag: null },
              { status: "Delivered", attempts: 1, lastFailureTag: null },
            ]);
          }).pipe(Effect.scoped),
      );
    });

    describe("retry", () => {
      it.effect(
        "retries with the stored envelope and the effect id as the provider idempotency key",
        () =>
          Effect.gen(function* () {
            yield* drain;
            yield* submit("retry-envelope");

            const [receipt, notification] = effects("retry-envelope");
            const stored = yield* storedEnvelopes("retry-envelope");
            const deliveries: Array<MailDeliveryRequest> = [];

            for (const attempt of [1, 2]) {
              expect(
                yield* deliverNext(failingMail("temporary-unavailability", deliveries)),
              ).toEqual(Failed({ effectId: receipt, failureTag: temporary }));
              expect(
                yield* deliverNext(failingMail("temporary-unavailability", deliveries)),
              ).toEqual(Failed({ effectId: notification, failureTag: temporary }));
              expect(yield* deliveryStates("retry-envelope")).toEqual([
                { status: "Failed", attempts: attempt, lastFailureTag: temporary },
                { status: "Failed", attempts: attempt, lastFailureTag: temporary },
              ]);
              expect(yield* storedEnvelopes("retry-envelope")).toEqual(stored);
            }

            expect(yield* deliverNext(recordingMail(deliveries))).toEqual(
              Delivered({ effectId: receipt }),
            );
            expect(yield* deliverNext(recordingMail(deliveries))).toEqual(
              Delivered({ effectId: notification }),
            );

            // Three attempts per effect, each the stored envelope under the effect's own id.
            for (const [index, effectId] of [receipt, notification].entries()) {
              const attempts = deliveries.filter(({ deliveryId }) => deliveryId === effectId);

              const envelope = yield* Schema.decodeEffect(
                Schema.fromJsonString(TeamApplicationEnvelope),
              )(stored[index] ?? "");

              expect(attempts).toEqual(Array.from({ length: 3 }, () => ({ ...envelope, sender })));
            }

            expect(yield* deliveryStates("retry-envelope")).toEqual([
              { status: "Delivered", attempts: 3, lastFailureTag: null },
              { status: "Delivered", attempts: 3, lastFailureTag: null },
            ]);
          }),
      );
    });

    describe("quarantine", () => {
      it.effect(
        "quarantines permanent and ambiguous failures and the last attempt's failure, visible in the delivery status",
        () =>
          Effect.gen(function* () {
            yield* drain;

            for (const kind of ["permanent-rejection", "ambiguous-outcome"] as const) {
              const command = `quarantine-${kind}`;
              const [receipt, notification] = effects(command);
              const failureTag = `MailDeliveryError:${kind}`;

              yield* submit(command);
              expect(yield* deliverNext(failingMail(kind))).toEqual(
                Quarantined({ effectId: receipt, failureTag }),
              );
              expect(yield* deliverNext(failingMail(kind))).toEqual(
                Quarantined({ effectId: notification, failureTag }),
              );
              expect(yield* deliveryStates(command)).toEqual([
                { status: "Quarantined", attempts: 1, lastFailureTag: failureTag },
                { status: "Quarantined", attempts: 1, lastFailureTag: failureTag },
              ]);
              expect(yield* storedEnvelopes(command)).toEqual(["{}", "{}"]);
            }

            yield* submit("quarantine-exhausted");

            const [receipt, notification] = effects("quarantine-exhausted");

            for (const outcome of [Failed, Failed, Quarantined] as const) {
              expect(yield* deliverNext(failingMail("temporary-unavailability"))).toEqual(
                outcome({ effectId: receipt, failureTag: temporary }),
              );
              expect(yield* deliverNext(failingMail("temporary-unavailability"))).toEqual(
                outcome({ effectId: notification, failureTag: temporary }),
              );
            }

            expect(yield* deliveryStates("quarantine-exhausted")).toEqual([
              { status: "Quarantined", attempts: 3, lastFailureTag: temporary },
              { status: "Quarantined", attempts: 3, lastFailureTag: temporary },
            ]);
            expect(yield* storedEnvelopes("quarantine-exhausted")).toEqual(["{}", "{}"]);
            expect(yield* deliverNext(recordingMail([]), "1500 millis")).toEqual(Idle());
          }),
      );

      it.effect("quarantines without a provider call when the last attempt's lease expired", () =>
        Effect.gen(function* () {
          yield* drain;
          yield* submit("quarantine-lease");

          const [receipt] = effects("quarantine-lease");
          const deliveries: Array<MailDeliveryRequest> = [];

          // A worker that stopped during the last attempt left its lease behind.
          yield* Database.use(
            (sql) => sql`
                UPDATE effect_queue SET attempts = 3,
                  acquired_by = '11111111-1111-4111-8111-111111111111',
                  acquired_at = now() - interval '1 hour'
                WHERE id = ${receipt}
              `,
          );

          const outcomes = [
            yield* deliverNext(recordingMail(deliveries)),
            yield* deliverNext(recordingMail(deliveries)),
          ];

          expect(outcomes).toContainEqual(
            Quarantined({ effectId: receipt, failureTag: "TeamApplicationDeliveryLeaseExpired" }),
          );
          expect(deliveries.map(({ deliveryId }) => deliveryId)).not.toContain(receipt);
          expect((yield* deliveryStates("quarantine-lease"))[0]).toEqual({
            status: "Quarantined",
            attempts: 4,
            lastFailureTag: "TeamApplicationDeliveryLeaseExpired",
          });
        }),
      );

      it.effect(
        "keeps the outbox evidence through queue cleanup, so a replay after it delivers nothing again",
        () =>
          Effect.gen(function* () {
            yield* drain;

            const [receipt, notification] = effects("cleanup-replay");
            const submitted = yield* submit("cleanup-replay");
            const deliveries: Array<MailDeliveryRequest> = [];

            yield* deliverNext(recordingMail(deliveries));
            yield* deliverNext(recordingMail(deliveries));
            expect(deliveries).toHaveLength(2);

            // The most eager cleanup: every completed item goes.
            const { queue, store } = Context.get(yield* worker(), TeamApplicationDeliveryQueue);

            yield* store.cleanup({ timeToLive: Duration.zero, failedTimeToLive: undefined });
            expect(yield* queueRows("cleanup-replay")).toEqual([]);
            expect(yield* deliveryStates("cleanup-replay")).toEqual([
              { status: "Delivered", attempts: 0, lastFailureTag: null },
              { status: "Delivered", attempts: 0, lastFailureTag: null },
            ]);

            // The command receipt answers a replay, which enqueues nothing.
            expect(yield* submit("cleanup-replay")).toEqual({
              confirmation: submitted.confirmation,
              replayed: true,
            });
            expect(yield* queueRows("cleanup-replay")).toEqual([]);

            // An offer under the same identities, as a replay without its receipt would make,
            // is taken and skipped: the outbox row still records the outcome.
            yield* queue.offer({ effectId: receipt }, { id: receipt });
            yield* queue.offer({ effectId: notification }, { id: notification });

            expect(yield* deliverNext(recordingMail(deliveries))).toEqual(
              Skipped({ effectId: receipt, status: "Delivered" }),
            );
            expect(yield* deliverNext(recordingMail(deliveries))).toEqual(
              Skipped({ effectId: notification, status: "Delivered" }),
            );
            expect(deliveries).toHaveLength(2);
          }).pipe(Effect.scoped),
      );
    });

    describe("cancellation and terminal scrubbing", () => {
      it.effect(
        "cancels and clears undelivered notifications on deletion, also during an attempt",
        () =>
          Effect.gen(function* () {
            yield* drain;

            const deliveries: Array<MailDeliveryRequest> = [];

            // Deleted before any attempt.
            const pending = yield* submit("cancel-pending");
            const [pendingReceipt, pendingNotification] = effects("cancel-pending");

            yield* deleteApplication(pending.confirmation.applicationId, "delete-pending");
            expect(yield* deliverNext(recordingMail(deliveries))).toEqual(
              Skipped({ effectId: pendingReceipt, status: "Cancelled" }),
            );
            expect(yield* deliverNext(recordingMail(deliveries))).toEqual(
              Skipped({ effectId: pendingNotification, status: "Cancelled" }),
            );

            // Deleted while both wait for their retry.
            const failed = yield* submit("cancel-failed");
            const [failedReceipt, failedNotification] = effects("cancel-failed");

            yield* deliverNext(failingMail("temporary-unavailability"));
            yield* deliverNext(failingMail("temporary-unavailability"));
            yield* deleteApplication(failed.confirmation.applicationId, "delete-failed");
            expect(yield* deliverNext(recordingMail(deliveries))).toEqual(
              Skipped({ effectId: failedReceipt, status: "Cancelled" }),
            );
            expect(yield* deliverNext(recordingMail(deliveries))).toEqual(
              Skipped({ effectId: failedNotification, status: "Cancelled" }),
            );

            // Deleted during the provider call of an attempt.
            const inFlight = yield* submit("cancel-in-flight");
            const [inFlightReceipt, inFlightNotification] = effects("cancel-in-flight");
            const services = yield* Effect.context<Database | TeamApplications>();

            const deletingMail = Layer.succeed(
              Mail,
              Mail.of({
                deliver: (request) =>
                  deleteApplication(inFlight.confirmation.applicationId, "delete-in-flight").pipe(
                    Effect.provideContext(services),
                    Effect.orDie,
                    Effect.as({ providerReference: request.deliveryId }),
                  ),
              }),
            );

            expect(yield* deliverNext(deletingMail)).toEqual(
              Superseded({ effectId: inFlightReceipt }),
            );
            expect(yield* deliverNext(recordingMail(deliveries))).toEqual(
              Skipped({ effectId: inFlightNotification, status: "Cancelled" }),
            );

            expect(deliveries).toEqual([]);

            for (const command of ["cancel-pending", "cancel-failed", "cancel-in-flight"]) {
              expect(yield* deliveryStates(command)).toEqual([
                expect.objectContaining({
                  status: "Cancelled",
                  lastFailureTag: "TeamApplicationDeleted",
                }),
                expect.objectContaining({
                  status: "Cancelled",
                  lastFailureTag: "TeamApplicationDeleted",
                }),
              ]);
              expect(yield* storedEnvelopes(command)).toEqual(["{}", "{}"]);
              expect((yield* queueRows(command)).map(({ state }) => state)).toEqual([
                "completed",
                "completed",
              ]);
            }
          }),
      );

      it.effect("keeps the migration 0069 guards of terminal and private outbox rows", () =>
        Effect.gen(function* () {
          yield* drain;
          yield* submit("guard-delivered");
          yield* submit("guard-pending");
          yield* deliverNext(recordingMail([]));
          yield* deliverNext(recordingMail([]));

          const [delivered] = effects("guard-delivered");
          const [pending] = effects("guard-pending");

          const rejected = (statement: string) =>
            Database.use((sql) => sql.unsafe(statement)).pipe(
              Effect.flip,
              Effect.map(() => "rejected"),
            );

          // A terminal status keeps no envelope, and only a terminal status clears it.
          expect(
            yield* rejected(
              `UPDATE team_application_outbox SET status = 'Delivered' WHERE effect_id = '${pending}'`,
            ),
          ).toBe("rejected");
          expect(
            yield* rejected(
              `UPDATE team_application_outbox SET payload_json = '{}'::jsonb WHERE effect_id = '${pending}'`,
            ),
          ).toBe("rejected");
          // An envelope can only be cleared, never replaced.
          expect(
            yield* rejected(
              `UPDATE team_application_outbox
                 SET payload_json = jsonb_set(payload_json, '{subject}', '"Endret"')
               WHERE effect_id = '${pending}'`,
            ),
          ).toBe("rejected");
          // A terminal outcome is final.
          expect(
            yield* rejected(
              `UPDATE team_application_outbox SET status = 'Cancelled',
                 last_failure_tag = 'TeamApplicationDeleted' WHERE effect_id = '${delivered}'`,
            ),
          ).toBe("rejected");
          expect(yield* storedEnvelopes("guard-delivered")).toEqual(["{}", "{}"]);
        }),
      );
    });
  },
);
