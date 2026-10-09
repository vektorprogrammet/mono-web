/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { assert, it, layer } from "@effect/vitest";
import { startDisposablePostgres, type DisposablePostgres } from "@monoweb/postgres";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import * as PersistedQueue from "effect/persistence/PersistedQueue";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import { createConnection } from "node:net";
import type { NativePgPoolConfig } from "../pg-pool.js";
import { DatabaseLive } from "../layers.js";
import { Database } from "../service.js";
import { nativePgLayer } from "../pg-pool.js";
import { NativeDatabaseStartupOptions } from "../search-path.js";
import { TestPlatform } from "../test-support/platform.js";
import {
  TeamApplicationDeliveryQueue,
  TeamApplicationDeliveryQueueLive,
  type TeamApplicationDeliveryOptions,
} from "./outbox.js";

class Postgres extends Context.Service<Postgres, DisposablePostgres>()(
  "@vektorprogrammet/database/team-application/queue-deadline.test/Postgres",
) {}

/** The suite owns deterministic unique identities for simultaneous attempts on one item. */
class AttemptSequence extends Context.Service<AttemptSequence, Ref.Ref<number>>()(
  "@vektorprogrammet/database/team-application/queue-deadline.test/AttemptSequence",
) {}

const attemptSequence = Layer.effect(AttemptSequence, Ref.make(0));

const postgres = Layer.effect(
  Postgres,
  Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ database: "queue_deadline" })),
    (started) => Effect.promise(() => started.stop()),
  ),
);

interface TransportReceipts {
  readonly stream: NonNullable<NativePgPoolConfig["stream"]>;
  readonly awaitClosed: Effect.Effect<void>;
  readonly closed: () => boolean;
}

/** Actual close events from the native driver's public Duplex factory, not pool bookkeeping. */
// EX-0032: public native Duplex ABI; actual physical close receipts, not an alternate driver.
const trackedTransport = Effect.fnUntraced(function* (
  started: DisposablePostgres,
): Effect.fn.Return<TransportReceipts, never, Scope.Scope> {
  const run = yield* FiberSet.makeRuntime();
  const records: Array<{ readonly receipt: Deferred.Deferred<void>; closed: boolean }> = [];

  return {
    stream: () => {
      const record = { receipt: Deferred.makeUnsafe<void>(), closed: false };
      records.push(record);
      const socket = createConnection({ host: "127.0.0.1", port: started.port });
      socket.once("close", () => {
        record.closed = true;
        run(Deferred.succeed(record.receipt, undefined));
      });

      return socket;
    },
    awaitClosed: Effect.suspend(() =>
      Effect.forEach(records, (record) => Deferred.await(record.receipt), { discard: true }),
    ),
    closed: () => records.length > 0 && records.every((record) => record.closed),
  };
});

const database = (
  started: DisposablePostgres,
  applicationName: string,
  observer?: {
    readonly onAcquire: () => void;
    readonly onMigration: () => void;
    readonly onRelease: () => void;
  },
  stream?: NativePgPoolConfig["stream"],
) =>
  DatabaseLive(
    {
      url: Redacted.make(started.url),
      applicationName,
      maxConnections: 2,
      connectTimeout: "200 millis",
      stream,
      startupOptions: NativeDatabaseStartupOptions,
    },
    observer,
  ).pipe(Layer.provide(TestPlatform));

const suite = Layer.unwrap(
  Effect.map(Postgres, (started) => database(started, "queue-observer")),
).pipe(Layer.provideMerge(postgres), Layer.provideMerge(attemptSequence));

class AttemptRejected extends Schema.TaggedError<AttemptRejected>()("AttemptRejected", {}) {}

const QueueRow = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["pending", "completed", "failed"]),
  attempts: Schema.Int,
  acquiredBy: Schema.NullOr(Schema.String),
  element: Schema.String,
  leaseFresh: Schema.NullOr(Schema.Boolean),
  retrySeconds: Schema.Int,
});

const decodeQueueRows = Schema.decodeUnknownEffect(Schema.Array(QueueRow));

const readRow = Effect.fnUntraced(function* (id: string) {
  const rows = yield* Database.use(
    (sql) => sql`
      SELECT id, state, attempts, acquired_by AS "acquiredBy", element,
        acquired_at > now() - interval '60 seconds' AS "leaseFresh",
        extract(epoch FROM visible_at - updated_at)::integer AS "retrySeconds"
      FROM effect_queue WHERE id = ${id}
    `,
  ).pipe(Effect.flatMap(decodeQueueRows));

  assert.strictEqual(rows.length, 1);

  return yield* Effect.fromNullishOr(rows[0]);
});

const expireLease = (id: string) =>
  Database.use(
    (sql) => sql`
      UPDATE effect_queue SET acquired_at = now() - interval '61 seconds' WHERE id = ${id}
    `,
  );

/** Each take owns a fresh pool and the native store's refresh/poll fibers until its graph closes. */
const startTake = Effect.fnUntraced(function* (
  id: string,
  overrides: Partial<TeamApplicationDeliveryOptions> = {},
) {
  const started = yield* Postgres;
  const sequence = yield* Ref.updateAndGet(yield* AttemptSequence, (value) => value + 1);
  const applicationName = `queue-${id}-${sequence}`;
  const transport = yield* trackedTransport(started);

  const claimed = yield* Deferred.make<{
    readonly attempts: number;
    readonly applicationName: string;
  }>();

  const work = yield* Deferred.make<void, AttemptRejected>();
  const released = yield* Deferred.make<void>();
  const lifecycle = { acquired: 0, released: 0 };

  const fiber = yield* Effect.gen(function* () {
    const graph = yield* Layer.build(
      TeamApplicationDeliveryQueueLive({ pollInterval: "20 millis", ...overrides }).pipe(
        Layer.provideMerge(
          database(
            started,
            applicationName,
            {
              onAcquire: () => {
                lifecycle.acquired += 1;
              },
              onMigration: () => {},
              onRelease: () => {
                lifecycle.released += 1;
              },
            },
            transport.stream,
          ),
        ),
      ),
    );

    const { queue } = Context.get(graph, TeamApplicationDeliveryQueue);
    yield* queue.offer({ effectId: id }, { id });

    return yield* queue.take(({ effectId }, metadata) =>
      Deferred.succeed(claimed, { attempts: metadata.attempts, applicationName }).pipe(
        Effect.andThen(Deferred.await(work)),
        Effect.as(effectId),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.ensuring(
      transport.awaitClosed.pipe(Effect.andThen(Deferred.succeed(released, undefined))),
    ),
    Effect.forkScoped,
  );

  return {
    fiber,
    work,
    released,
    lifecycle,
    transport,
    ...(yield* Deferred.await(claimed).pipe(Effect.timeout("10 seconds"))),
  };
});

/**
 * The disposable cluster's outage callback is a Promise host boundary. Its one scoped
 * FiberSet runner owns the callback and forwards interruption; the cluster restarts in
 * its own finally. No queue or SQL operation is replaced by a test double.
 */
const duringOutage = Effect.fnUntraced(function* <A, E, R>(body: Effect.Effect<A, E, R>) {
  const started = yield* Postgres;
  const run = yield* FiberSet.makeRuntimePromise<R>();

  const exit = yield* Effect.promise((signal) =>
    started.outage(() => run(Effect.exit(body), { signal })),
  );

  if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);

  return exit.value;
});

const assertNoSessions = Effect.fnUntraced(function* (applicationName: string) {
  const rows = yield* Database.use(
    (sql) => sql`SELECT count(*)::integer AS count
    FROM pg_stat_activity WHERE application_name = ${applicationName}`,
  );

  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ count: Schema.Int })),
  )(rows);

  assert.deepStrictEqual(decoded, [{ count: 0 }]);
});

const assertReleased = Effect.fnUntraced(function* (attempt: {
  readonly applicationName: string;
  readonly transport: TransportReceipts;
  readonly lifecycle: { readonly acquired: number; readonly released: number };
}) {
  assert.deepStrictEqual(attempt.lifecycle, { acquired: 1, released: 1 });
  yield* attempt.transport.awaitClosed;
  assert.isTrue(attempt.transport.closed());
  yield* assertNoSessions(attempt.applicationName);
});

/** Each verification acquires its own real SQL pool; read-only is enforced by PostgreSQL. */
const verifyFreshStore = Effect.fnUntraced(function* (applicationName: string) {
  const started = yield* Postgres;

  const transport = yield* trackedTransport(started);

  yield* Effect.gen(function* () {
    const graph = yield* Layer.build(
      nativePgLayer({
        url: Redacted.make(started.url),
        applicationName,
        stream: transport.stream,
        maxConnections: 1,
        connectTimeout: "200 millis",
        startupOptions: NativeDatabaseStartupOptions,
      }),
    );

    const sql = Context.get(graph, SqlClient.SqlClient);
    yield* sql`SET lock_timeout = '1s'`;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION READ ONLY`;
          const options = { tableName: "effect_queue", migrations: "verify" as const };
          const store = yield* PersistedQueue.makeStoreSql(options);
          assert.isFunction(store.offer);
        }),
      )
      .pipe(Effect.provideService(SqlClient.SqlClient, sql));

    return;
  }).pipe(Effect.scoped);

  yield* transport.awaitClosed;
  assert.isTrue(transport.closed());
  yield* assertNoSessions(applicationName);

  return transport;
});

const assertAckDefect = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));

  if (Exit.isFailure(exit)) {
    assert.isTrue(
      exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && isSqlError(reason.defect)),
    );
  }
};

/** Real PostgreSQL and live scheduling: connection refusal bounds each statement in this probe, not in a Worker. */
layer(suite, { excludeTestServices: true, timeout: "120 seconds" })(
  "SQL queue acknowledgement retry window",
  (it) => {
    it.effect("preserves a typed outage-body failure and waits for the real server restart", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(duringOutage(Effect.fail(new AttemptRejected())));
        assert.instanceOf(error, AttemptRejected);
        const rows = yield* Database.use((sql) => sql`SELECT 1::integer AS ready`);
        assert.deepStrictEqual(rows, [{ ready: 1 }]);
      }),
    );
    it.effect("acquires an externally provisioned native store in a read-only transaction", () =>
      Database.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET TRANSACTION READ ONLY`;
            const options = { tableName: "effect_queue", migrations: "verify" as const };

            const store = yield* PersistedQueue.makeStoreSql(options).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );

            assert.isFunction(store.offer);
          }).pipe(Effect.scoped),
        ),
      ),
    );
    it.effect(
      "concurrently verifies two fresh graphs while a shared ledger lock excludes migration",
      () =>
        Database.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`LOCK TABLE effect_queue_migrations IN SHARE MODE`;

              const pools = yield* Effect.all(
                [verifyFreshStore("queue-verify-one"), verifyFreshStore("queue-verify-two")],
                { concurrency: 2 },
              );

              assert.notStrictEqual(pools[0], pools[1]);
            }),
          ),
        ),
    );
    it.effect(
      "keeps default provisioning and rejects missing or incomplete externally owned schema",
      () =>
        Database.use((sql) =>
          Effect.gen(function* () {
            const tableName = "queue_verify_schema";
            yield* PersistedQueue.makeStoreSql({ tableName });

            const verify = PersistedQueue.makeStoreSql({
              tableName,
              migrations: "verify" as const,
            });

            yield* verify;

            const controls = [
              { mutation: sql`DROP TABLE queue_verify_schema_migrations`, migrationError: false },
              { mutation: sql`DROP TABLE queue_verify_schema`, migrationError: false },
              {
                mutation: sql`ALTER TABLE queue_verify_schema DROP COLUMN visible_at`,
                migrationError: false,
              },
              {
                mutation: sql`DELETE FROM queue_verify_schema_migrations
              WHERE migration_id = (SELECT MAX(migration_id) FROM queue_verify_schema_migrations)`,
                migrationError: true,
              },
              { mutation: sql`DELETE FROM queue_verify_schema_migrations`, migrationError: true },
            ];

            for (const control of controls) {
              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    yield* control.mutation;
                    const error = yield* Effect.flip(verify);

                    if (control.migrationError) {
                      assert.instanceOf(error, Migrator.MigrationError);

                      if (error instanceof Migrator.MigrationError)
                        assert.strictEqual(error.kind, "BadState");
                    } else {
                      assert.isTrue(isSqlError(error));
                    }

                    return yield* new AttemptRejected();
                  }),
                )
                .pipe(Effect.catchTag("AttemptRejected", () => Effect.void));
              yield* verify;
            }

            const absent = yield* Effect.flip(
              PersistedQueue.makeStoreSql({
                tableName: "queue_verify_absent",
                migrations: "verify" as const,
              }),
            );

            assert.isTrue(isSqlError(absent));

            const rows = yield* sql`SELECT to_regclass('queue_verify_absent') IS NULL
            AND to_regclass('queue_verify_absent_migrations') IS NULL AS absent`;

            const [result] = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ absent: Schema.Boolean })),
            )(rows);

            assert.isTrue(result?.absent);
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.scoped),
        ),
    );
    it.effect("interrupts a verified graph and closes its native pool and store scope", () =>
      Effect.gen(function* () {
        const started = yield* Postgres;
        const acquired = yield* Deferred.make<void>();
        const transport = yield* trackedTransport(started);

        const fiber = yield* Effect.gen(function* () {
          yield* Layer.build(
            PersistedQueue.layerStoreSql({ migrations: "verify" }).pipe(
              Layer.provideMerge(
                nativePgLayer({
                  url: Redacted.make(started.url),
                  applicationName: "queue-verify-interrupt",
                  stream: transport.stream,
                  maxConnections: 1,
                  connectTimeout: "200 millis",
                  startupOptions: NativeDatabaseStartupOptions,
                }),
              ),
            ),
          );

          yield* Deferred.succeed(acquired, undefined);

          return yield* Effect.never;
        }).pipe(Effect.scoped, Effect.forkScoped);

        yield* Deferred.await(acquired);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
        yield* transport.awaitClosed;
        assert.isTrue(transport.closed());
        yield* assertNoSessions("queue-verify-interrupt");
      }),
    );
    it.effect(
      "releases a configured graph during an ack outage while omission keeps the old lease-sized retry window",
      () =>
        Effect.gen(function* () {
          const bounded = yield* startTake("bounded-complete", { ackRetryDuration: "2 seconds" });

          // An ack window is not the lease: a three-second-old live claim still excludes another owner.
          yield* Database.use(
            (sql) => sql`
            UPDATE effect_queue SET acquired_at = now() - interval '3 seconds'
            WHERE id = 'bounded-complete'
          `,
          );

          const before = yield* readRow("bounded-complete");

          yield* Effect.gen(function* () {
            const graph = yield* Layer.build(
              TeamApplicationDeliveryQueueLive({
                ackRetryDuration: "2 seconds",
                pollInterval: "20 millis",
              }),
            );

            const claimed = yield* Deferred.make<void>();
            const { queue } = Context.get(graph, TeamApplicationDeliveryQueue);

            const waiting = yield* queue
              .take(() => Deferred.succeed(claimed, undefined).pipe(Effect.andThen(Effect.never)))
              .pipe(Effect.timeoutOption("200 millis"));

            assert.isTrue(Option.isNone(waiting));
            assert.isFalse(yield* Deferred.isDone(claimed));
          }).pipe(Effect.scoped);

          const held = yield* readRow("bounded-complete");

          assert.strictEqual(held.acquiredBy, before.acquiredBy);
          assert.strictEqual(held.attempts, 1);
          assert.isTrue(held.leaseFresh);

          const omitted = yield* startTake("omitted-complete");

          assert.strictEqual(bounded.attempts, 1);
          assert.isTrue(before.leaseFresh);

          const observation = yield* duringOutage(
            Effect.gen(function* () {
              const began = yield* Clock.monotonicTimeNanos;
              yield* Deferred.succeed(bounded.work, undefined);
              yield* Deferred.succeed(omitted.work, undefined);

              const released = yield* Deferred.await(bounded.released).pipe(
                Effect.timeoutOption("4 seconds"),
              );

              const elapsedMillis = Number((yield* Clock.monotonicTimeNanos) - began) / 1_000_000;

              return {
                released,
                elapsedMillis,
                omittedReleased: yield* Deferred.isDone(omitted.released),
                boundedTransportsClosed: bounded.transport.closed(),
                boundedReleases: bounded.lifecycle.released,
              };
            }),
          );

          // Observe both fibers after restart even in the red run, so a failed assertion leaves no owner behind.
          const boundedExit = yield* Fiber.await(bounded.fiber);
          assert.strictEqual(yield* Fiber.join(omitted.fiber), "omitted-complete");
          assert.isTrue(Option.isSome(observation.released));
          assert.isBelow(observation.elapsedMillis, 4_000);
          assert.isFalse(observation.omittedReleased);
          assert.isTrue(observation.boundedTransportsClosed);
          assert.strictEqual(observation.boundedReleases, 1);
          assertAckDefect(boundedExit);
          yield* assertReleased(bounded);
          yield* assertReleased(omitted);
          yield* Effect.logInfo(
            "queue acknowledgement outage release",
            observation.elapsedMillis,
            "milliseconds; omitted owner still waiting",
          );

          const unsettled = yield* readRow("bounded-complete");
          assert.strictEqual(unsettled.state, "pending");
          assert.strictEqual(unsettled.attempts, 1);
          assert.strictEqual(unsettled.acquiredBy, before.acquiredBy);
          assert.strictEqual(unsettled.element, before.element);
          assert.isTrue(unsettled.leaseFresh);
          yield* expireLease("bounded-complete");
          const successor = yield* startTake("bounded-complete", { ackRetryDuration: "2 seconds" });
          assert.strictEqual(successor.attempts, 2);
          assert.notStrictEqual((yield* readRow("bounded-complete")).acquiredBy, before.acquiredBy);
          yield* Deferred.succeed(successor.work, undefined);
          assert.strictEqual(yield* Fiber.join(successor.fiber), "bounded-complete");
          yield* assertReleased(successor);
          const recovered = yield* readRow("bounded-complete");
          assert.strictEqual(recovered.state, "completed");
          assert.strictEqual(recovered.attempts, 2);
          assert.isNull(recovered.acquiredBy);
        }),
      30_000,
    );

    it.effect.each(["failure", "interruption"] as const)(
      "preserves an unsettled %s ack and recovers its persisted attempt with a new owner",
      (outcome) =>
        Effect.gen(function* () {
          const id = `bounded-${outcome}`;
          const attempt = yield* startTake(id, { ackRetryDuration: "2 seconds" });
          const before = yield* readRow(id);

          const released = yield* duringOutage(
            Effect.gen(function* () {
              if (outcome === "failure") {
                yield* Deferred.fail(attempt.work, new AttemptRejected());
              } else {
                yield* Fiber.interrupt(attempt.fiber).pipe(Effect.forkScoped);
              }

              return yield* Deferred.await(attempt.released).pipe(
                Effect.timeoutOption("4 seconds"),
              );
            }),
          );

          const exit = yield* Fiber.await(attempt.fiber);
          assert.isTrue(Option.isSome(released));
          assertAckDefect(exit);

          if (Exit.isFailure(exit)) {
            assert.strictEqual(Cause.hasInterrupts(exit.cause), outcome === "interruption");
            assert.strictEqual(Cause.hasFails(exit.cause), outcome === "failure");
          }

          yield* assertReleased(attempt);
          const unsettled = yield* readRow(id);
          assert.strictEqual(unsettled.state, "pending");
          assert.strictEqual(unsettled.attempts, 1);
          assert.strictEqual(unsettled.acquiredBy, before.acquiredBy);
          assert.strictEqual(unsettled.element, before.element);
          yield* expireLease(id);
          const successor = yield* startTake(id, { ackRetryDuration: "2 seconds" });
          assert.strictEqual(successor.attempts, 2);
          yield* Deferred.fail(successor.work, new AttemptRejected());
          const failed = yield* Fiber.await(successor.fiber);
          assert.isTrue(Exit.hasFails(failed));
          yield* assertReleased(successor);
          const retry = yield* readRow(id);
          assert.strictEqual(retry.attempts, 2);
          assert.strictEqual(retry.state, "pending");
          assert.isNull(retry.acquiredBy);
          assert.strictEqual(retry.retrySeconds, 2);
          // Make only the due instant eligible; do not change the persisted attempts/backoff policy.
          yield* Database.use(
            (sql) => sql`UPDATE effect_queue SET visible_at = now() WHERE id = ${id}`,
          );
          const final = yield* startTake(id, { ackRetryDuration: "2 seconds" });
          assert.strictEqual(final.attempts, 3);
          yield* Deferred.succeed(final.work, undefined);
          yield* Fiber.join(final.fiber);
          yield* assertReleased(final);
        }),
      30_000,
    );

    it.effect(
      "does not let a stale completion or interruption settle or decrement the successor's lease",
      () =>
        Effect.gen(function* () {
          for (const outcome of ["completion", "interruption"] as const) {
            const id = `stale-${outcome}`;
            const stale = yield* startTake(id, { ackRetryDuration: "2 seconds" });
            yield* expireLease(id);
            const successor = yield* startTake(id, { ackRetryDuration: "2 seconds" });
            const claimed = yield* readRow(id);
            assert.strictEqual(successor.attempts, 2);

            if (outcome === "completion") {
              yield* Deferred.succeed(stale.work, undefined);
              yield* Fiber.join(stale.fiber);
            } else {
              yield* Fiber.interrupt(stale.fiber);
              const interrupted = yield* Fiber.await(stale.fiber);
              assert.isTrue(
                Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause),
              );
            }

            yield* assertReleased(stale);
            const fenced = yield* readRow(id);
            assert.strictEqual(fenced.state, "pending");
            assert.strictEqual(fenced.attempts, 2);
            assert.strictEqual(fenced.acquiredBy, claimed.acquiredBy);
            assert.strictEqual(fenced.element, claimed.element);
            yield* Deferred.succeed(successor.work, undefined);
            yield* Fiber.join(successor.fiber);
            yield* assertReleased(successor);
            assert.strictEqual((yield* readRow(id)).state, "completed");
          }
        }),
      30_000,
    );

    it.effect(
      "applies the same retry window through the native SQL-store layer entrypoint",
      () =>
        Effect.gen(function* () {
          const sql = yield* Database;

          const graph = yield* Layer.build(
            PersistedQueue.layer.pipe(
              Layer.provide(
                PersistedQueue.layerStoreSql({
                  ackRetryDuration: "2 seconds",
                  lockExpiration: "1 minute",
                  lockRefreshInterval: "20 seconds",
                  pollInterval: "20 millis",
                }),
              ),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
            ),
          );

          const queue = yield* Context.get(graph, PersistedQueue.PersistedQueueFactory).make({
            name: "native-ack-layer",
            schema: Schema.String,
          });

          yield* queue.offer("native", { id: "native-layer" });
          const claimed = yield* Deferred.make<void>();
          const work = yield* Deferred.make<void>();

          const fiber = yield* queue
            .take(() =>
              Deferred.succeed(claimed, undefined).pipe(Effect.andThen(Deferred.await(work))),
            )
            .pipe(Effect.forkScoped);

          yield* Deferred.await(claimed).pipe(Effect.timeout("5 seconds"));

          const done = yield* duringOutage(
            Deferred.succeed(work, undefined).pipe(
              Effect.andThen(Fiber.await(fiber)),
              Effect.timeoutOption("4 seconds"),
            ),
          );

          yield* Fiber.await(fiber);
          assert.isTrue(Option.isSome(done));

          if (Option.isSome(done)) assertAckDefect(done.value);
          yield* expireLease("native-layer");
          yield* queue.take((value, metadata) =>
            Effect.sync(() => {
              assert.strictEqual(value, "native");
              assert.strictEqual(metadata.attempts, 2);
            }),
          );
        }),
      30_000,
    );
  },
);

it.effect(
  "keeps the twenty-second refresh clock independent of a two-second acknowledgement retry window",
  () =>
    Effect.gen(function* () {
      const attempt = yield* startTake("refresh-window", { ackRetryDuration: "2 seconds" });
      const owner = (yield* readRow("refresh-window")).acquiredBy;
      yield* expireLease("refresh-window");
      yield* TestClock.adjust("19 seconds");
      assert.isFalse((yield* readRow("refresh-window")).leaseFresh);
      yield* TestClock.adjust("1 second");
      const refreshed = yield* readRow("refresh-window");
      assert.isTrue(refreshed.leaseFresh);
      assert.strictEqual(refreshed.acquiredBy, owner);
      assert.strictEqual(refreshed.attempts, 1);
      yield* Fiber.interrupt(attempt.fiber);
      const exit = yield* Fiber.await(attempt.fiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      yield* assertReleased(attempt);
      const interrupted = yield* readRow("refresh-window");
      assert.isNull(interrupted.acquiredBy);
      assert.strictEqual(interrupted.attempts, 0);
      assert.strictEqual(interrupted.state, "pending");
    }).pipe(Effect.provide(suite)),
  120_000,
);
