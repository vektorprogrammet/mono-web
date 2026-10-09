/**
 * EX-0021: required public native SQL APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { assert, expectTypeOf, it, layer } from "@effect/vitest";
import * as PgConnection from "@effect/sql-pg/PgConnection";
import { startDisposablePostgres, type DisposablePostgres } from "@monoweb/postgres";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Schedule,
  Scope,
} from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { nativePgLayer } from "./pg-pool.js";
import {
  CloseSilentPgDuplex,
  observeNativePgTransport,
  readNativeHostRuntime,
  readNativeTimeoutCount,
  withFinWithheldPostgres,
  withStartupWithheldPostgres,
} from "./test-support/native-pg-transport.js";

class Postgres extends Context.Service<Postgres, DisposablePostgres>()(
  "@vektorprogrammet/database/native-postgres-deadlines.test/Postgres",
) {}

const postgres = Layer.effect(
  Postgres,
  Effect.acquireRelease(
    Effect.promise(() =>
      startDisposablePostgres({ database: "native_admission", maxConnections: 16 }),
    ),
    (started) => Effect.promise(() => started.stop()),
  ),
);

layer(postgres, { excludeTestServices: true, timeout: "30 seconds" })(
  "stable native transaction admission",
  (it) => {
    it.effect(
      "startup acquisition belongs to the pool owner until its scope closes after borrower cancellation",
      () =>
        Effect.gen(function* () {
          const started = yield* Postgres;

          return yield* withStartupWithheldPostgres(started, (endpoint) =>
            Effect.gen(function* () {
              const transport = yield* observeNativePgTransport(endpoint);

              const ownerScope = yield* Scope.make();

              yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));

              const context = yield* Scope.provide(
                Layer.build(
                  nativePgLayer({
                    url: Redacted.make(endpoint.url),
                    maxConnections: 1,
                    stream: transport.stream,
                    applicationName: "startup-cancel-subject",
                    connectTimeout: "30 seconds",
                    prepare: false,
                  }),
                ),
                ownerScope,
              );

              const sql = Context.get(context, SqlClient.SqlClient);
              const entries = yield* Ref.make(0);

              const waiting = yield* sql
                .withTransaction(Ref.update(entries, (count) => count + 1))
                .pipe(Effect.forkScoped);

              yield* transport.connected;
              yield* Effect.yieldNow;
              const cancellingAt = yield* Clock.monotonicTimeNanos;
              yield* Fiber.interrupt(waiting);
              const exit = yield* Fiber.await(waiting);
              // Native Pool forks startup into its owner scope, not the waiting borrower.
              assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
              assert.strictEqual(yield* Ref.get(entries), 0);
              assert.deepStrictEqual(
                (yield* transport.snapshot).map(({ destroyed, closed }) => ({ destroyed, closed })),
                [{ destroyed: false, closed: false }],
              );

              yield* Scope.close(ownerScope, Exit.void);
              yield* transport.closed;

              const closedAt = yield* Clock.monotonicTimeNanos;
              assert.isBelow(Number(closedAt - cancellingAt) / 1_000_000, 2000);
              assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
              assert.strictEqual(yield* Ref.get(entries), 0);
              assert.isTrue(
                (yield* transport.snapshot).every(({ destroyed, closed }) => destroyed && closed),
              );
            }),
          );
        }),
      10_000,
    );
    it.effect(
      "interrupts saturated transaction acquisition before the owner releases its connection",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Postgres;

            const context = yield* Layer.build(
              nativePgLayer({
                url: Redacted.make(started.url),
                applicationName: "native-admission",
                maxConnections: 1,
                connectTimeout: "2 seconds",
                prepare: false,
              }),
            );

            const sql = Context.get(context, SqlClient.SqlClient);

            const channelLaw: Effect.Effect<number, "law-failure", Postgres> = Effect.flatMap(
              Postgres,
              () => Effect.fail("law-failure" as const),
            );

            expectTypeOf(sql.withTransaction(channelLaw)).toEqualTypeOf<
              Effect.Effect<number, "law-failure" | SqlError, Postgres>
            >();
            yield* sql`CREATE TABLE admission_writes (value integer NOT NULL)`;

            const ownerAcquired = yield* Deferred.make<void>();
            const releaseOwner = yield* Deferred.make<void>();
            const waitingStarted = yield* Deferred.make<void>();
            const waitingStopped = yield* Deferred.make<void>();
            const bodyEntries = yield* Ref.make(0);

            const owner = yield* sql
              .withTransaction(
                sql`SELECT pg_backend_pid()`.pipe(
                  Effect.andThen(Deferred.succeed(ownerAcquired, undefined)),
                  Effect.andThen(Deferred.await(releaseOwner)),
                ),
              )
              .pipe(Effect.forkScoped);

            yield* Deferred.await(ownerAcquired);

            yield* Effect.gen(function* () {
              const waiting = yield* Deferred.succeed(waitingStarted, undefined).pipe(
                Effect.andThen(
                  sql.withTransaction(
                    Ref.update(bodyEntries, (count) => count + 1).pipe(
                      Effect.andThen(sql`INSERT INTO admission_writes (value) VALUES (1)`),
                    ),
                  ),
                ),
                Effect.forkScoped,
              );

              yield* Deferred.await(waitingStarted);
              yield* Effect.yieldNow;

              const interruption = yield* Fiber.interrupt(waiting).pipe(
                Effect.andThen(Deferred.succeed(waitingStopped, undefined)),
                Effect.forkScoped,
              );

              // The watchdog bounds a RED fixture. Only the actual stop receipt proves success.
              const stoppedBeforeRelease = yield* Deferred.await(waitingStopped).pipe(
                Effect.timeoutOption("250 millis"),
              );

              yield* Deferred.succeed(releaseOwner, undefined);
              yield* Fiber.join(owner);
              yield* Fiber.join(interruption);
              const exit = yield* Fiber.await(waiting);

              assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
              assert.strictEqual(yield* Ref.get(bodyEntries), 0);
              assert.deepStrictEqual(
                yield* sql<{ readonly count: number }>`
                  SELECT count(*)::integer AS count FROM admission_writes
                `,
                [{ count: 0 }],
              );
              assert.isTrue(
                Option.isSome(stoppedBeforeRelease),
                "native acquisition must stop while the competing transaction still owns its connection",
              );
            }).pipe(Effect.ensuring(Deferred.succeed(releaseOwner, undefined)));
          }),
        ),
      10_000,
    );

    for (const policy of [
      { name: "omitted / masked", masked: true, options: {}, stopsBeforeRelease: false },
      {
        name: "false / masked",
        masked: true,
        options: { acquisitionInterruptible: false },
        stopsBeforeRelease: false,
      },
      {
        name: "true / masked",
        masked: true,
        options: { acquisitionInterruptible: true },
        stopsBeforeRelease: true,
      },
      { name: "omitted / unmasked", masked: false, options: {}, stopsBeforeRelease: true },
      {
        name: "false / unmasked",
        masked: false,
        options: { acquisitionInterruptible: false },
        stopsBeforeRelease: true,
      },
      {
        name: "true / unmasked",
        masked: false,
        options: { acquisitionInterruptible: true },
        stopsBeforeRelease: true,
      },
    ]) {
      it.effect(
        `outer caller mask is preserved unless admission explicitly opts in: ${policy.name}`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const started = yield* Postgres;

              const context = yield* Layer.build(
                nativePgLayer({
                  url: Redacted.make(started.url),
                  maxConnections: 1,
                  prepare: false,
                  applicationName: "masked-admission",
                  ...policy.options,
                }),
              );

              const sql = Context.get(context, SqlClient.SqlClient);
              yield* sql`CREATE TEMP TABLE mask_admission_writes (value integer NOT NULL)`;
              const acquired = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const waitingStarted = yield* Deferred.make<void>();
              const waitingStopped = yield* Deferred.make<void>();
              const entries = yield* Ref.make(0);

              const owner = yield* sql
                .withTransaction(
                  sql`SELECT 1`.pipe(
                    Effect.andThen(Deferred.succeed(acquired, undefined)),
                    Effect.andThen(Deferred.await(release)),
                  ),
                )
                .pipe(Effect.forkScoped);

              yield* Deferred.await(acquired);
              yield* Effect.gen(function* () {
                const waiting = yield* Deferred.succeed(waitingStarted, undefined).pipe(
                  Effect.andThen(
                    sql.withTransaction(
                      Ref.update(entries, (count) => count + 1).pipe(
                        Effect.andThen(sql`INSERT INTO mask_admission_writes (value) VALUES (1)`),
                      ),
                    ),
                  ),
                  (effect) => (policy.masked ? Effect.uninterruptible(effect) : effect),
                  Effect.forkScoped,
                );

                yield* Deferred.await(waitingStarted);
                yield* Effect.yieldNow;

                const interruption = yield* Fiber.interrupt(waiting).pipe(
                  Effect.andThen(Deferred.succeed(waitingStopped, undefined)),
                  Effect.forkScoped,
                );

                const stopped = yield* Deferred.await(waitingStopped).pipe(
                  Effect.timeoutOption("250 millis"),
                );

                const before = yield* Ref.get(entries);
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(owner);
                yield* Fiber.join(interruption);
                const exit = yield* Fiber.await(waiting);
                assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
                assert.strictEqual(before, 0);
                assert.strictEqual(Option.isSome(stopped), policy.stopsBeforeRelease);
                const expectedEntries = Number(!policy.stopsBeforeRelease);
                assert.strictEqual(yield* Ref.get(entries), expectedEntries);
                assert.deepStrictEqual(
                  yield* sql<{
                    readonly count: number;
                  }>`SELECT count(*)::integer AS count FROM mask_admission_writes`,
                  [{ count: expectedEntries }],
                );
              }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
            }),
          ),
        10_000,
      );
    }

    it.effect(
      "nested savepoint failure rolls back only its body and preserves the owning transaction",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Postgres;

            const context = yield* Layer.build(
              nativePgLayer({ url: Redacted.make(started.url), maxConnections: 1, prepare: false }),
            );

            const sql = Context.get(context, SqlClient.SqlClient);
            yield* sql`CREATE TEMP TABLE nested_native_writes (value integer NOT NULL)`;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const outer = yield* sql<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`;
                yield* sql`INSERT INTO nested_native_writes (value) VALUES (1)`;

                const nested = yield* Effect.exit(
                  sql.withTransaction(
                    Effect.gen(function* () {
                      const inner = yield* sql<{
                        readonly pid: number;
                      }>`SELECT pg_backend_pid() AS pid`;

                      assert.deepStrictEqual(
                        inner,
                        outer,
                        "nested work must use the native owner's physical session",
                      );
                      yield* sql`INSERT INTO nested_native_writes (value) VALUES (2)`;
                      yield* sql`SELECT 1 / 0`;
                    }),
                  ),
                );

                assert.isTrue(Exit.isFailure(nested));
                yield* sql`INSERT INTO nested_native_writes (value) VALUES (3)`;
              }),
            );
            assert.deepStrictEqual(
              yield* sql<{
                readonly value: number;
              }>`SELECT value FROM nested_native_writes ORDER BY value`,
              [{ value: 1 }, { value: 3 }],
            );
          }),
        ),
      10_000,
    );

    it.effect(
      "interruption rolls back the body and releases capacity for the next transaction",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Postgres;

            const context = yield* Layer.build(
              nativePgLayer({ url: Redacted.make(started.url), maxConnections: 1, prepare: false }),
            );

            const sql = Context.get(context, SqlClient.SqlClient);
            yield* sql`CREATE TEMP TABLE cancelled_native_writes (value integer NOT NULL)`;
            const bodyEntered = yield* Deferred.make<void>();

            const cancelled = yield* sql
              .withTransaction(
                sql`INSERT INTO cancelled_native_writes (value) VALUES (1)`.pipe(
                  Effect.andThen(Deferred.succeed(bodyEntered, undefined)),
                  Effect.andThen(Effect.never),
                ),
              )
              .pipe(Effect.forkScoped);

            yield* Deferred.await(bodyEntered);
            yield* Fiber.interrupt(cancelled);
            const exit = yield* Fiber.await(cancelled);
            assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
            assert.deepStrictEqual(
              yield* sql<{
                readonly count: number;
              }>`SELECT count(*)::integer AS count FROM cancelled_native_writes`,
              [{ count: 0 }],
            );
            yield* sql.withTransaction(sql`INSERT INTO cancelled_native_writes (value) VALUES (2)`);
            assert.deepStrictEqual(
              yield* sql<{ readonly value: number }>`SELECT value FROM cancelled_native_writes`,
              [{ value: 2 }],
            );
          }),
        ),
      10_000,
    );

    it.effect(
      "interrupts a PostgreSQL-observed active query and releases its transaction capacity",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const started = yield* Postgres;

            const subjectContext = yield* Layer.build(
              nativePgLayer({
                url: Redacted.make(started.url),
                maxConnections: 1,
                prepare: false,
                applicationName: "active-cancel-subject",
              }),
            );

            const observerContext = yield* Layer.build(
              nativePgLayer({
                url: Redacted.make(started.url),
                maxConnections: 1,
                prepare: false,
                applicationName: "active-cancel-observer",
              }),
            );

            const sql = Context.get(subjectContext, SqlClient.SqlClient);
            const observer = Context.get(observerContext, SqlClient.SqlClient);

            const active = observer<{ readonly count: number }>`
          SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE application_name = 'active-cancel-subject' AND state = 'active'
            AND query LIKE '%pg_sleep%'
        `;

            const running = yield* sql
              .withTransaction(sql`SELECT pg_sleep(30)`)
              .pipe(Effect.forkScoped);

            yield* active.pipe(
              Effect.map((rows) => rows[0]?.count === 1),
              Effect.repeat(($) =>
                $(Schedule.spaced("10 millis")).pipe(Schedule.while(({ input }) => !input)),
              ),
              Effect.timeout("2 seconds"),
            );
            const cancellingAt = yield* Clock.monotonicTimeNanos;
            yield* Fiber.interrupt(running);
            const completedAt = yield* Clock.monotonicTimeNanos;
            const exit = yield* Fiber.await(running);
            assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
            assert.isBelow(Number(completedAt - cancellingAt) / 1_000_000, 2000);
            assert.deepStrictEqual(yield* active, [{ count: 0 }]);
            assert.deepStrictEqual(
              yield* sql.withTransaction(
                sql<{ readonly answer: number }>`SELECT 42::integer AS answer`,
              ),
              [{ answer: 42 }],
            );
          }),
        ),
      10_000,
    );
    it.effect(
      "closes the real native transport within two seconds when the peer withholds FIN",
      () =>
        Effect.gen(function* () {
          const started = yield* Postgres;

          const observerContext = yield* Layer.build(
            nativePgLayer({
              url: Redacted.make(started.url),
              maxConnections: 1,
              applicationName: "physical-close-observer",
              prepare: false,
            }),
          );

          const observer = Context.get(observerContext, SqlClient.SqlClient);

          return yield* withFinWithheldPostgres(started, (endpoint) =>
            Effect.gen(function* () {
              const transport = yield* observeNativePgTransport(endpoint);
              const scope = yield* Scope.make();
              yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

              const context = yield* Scope.provide(
                Layer.build(
                  nativePgLayer({
                    url: Redacted.make(endpoint.url),
                    maxConnections: 1,
                    applicationName: "physical-close-subject",
                    connectTimeout: "2 seconds",
                    stream: transport.stream,
                    shutdownTimeout: "1800 millis",
                    prepare: false,
                  }),
                ),
                scope,
              );

              const sql = Context.get(context, SqlClient.SqlClient);

              const rows = yield* sql<{
                readonly pid: number;
                readonly answer: number;
              }>`SELECT pg_backend_pid() AS pid, 42::integer AS answer`;

              assert.strictEqual(rows.length, 1);
              const row = yield* Effect.fromNullishOr(rows[0]);
              assert.strictEqual(row.answer, 42);

              const closingAt = yield* Clock.monotonicTimeNanos;
              yield* Scope.close(scope, Exit.void);
              const scopeClosedAt = yield* Clock.monotonicTimeNanos;
              assert.isBelow(Number(scopeClosedAt - closingAt) / 1_000_000, 2000);

              const physicallyClosed = yield* transport.closed.pipe(
                Effect.timeoutOption("2 seconds"),
              );

              const snapshot = yield* transport.snapshot;
              const socket = yield* Effect.fromNullishOr(snapshot[0]);
              const closedAt = yield* Effect.fromNullishOr(socket.closedAtNanos);
              const closeMilliseconds = Number(closedAt - closingAt) / 1_000_000;
              assert.isAtLeast(
                closeMilliseconds,
                1800,
                "no real close receipt may precede the owner's force deadline",
              );
              assert.isBelow(
                closeMilliseconds,
                2000,
                "the force and its receipt retain the total two-second bound",
              );

              const backend = yield* observer<{
                readonly count: number;
              }>`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid = ${row.pid}`;

              assert.deepStrictEqual(backend, [{ count: 0 }]);
              yield* Effect.logInfo("Native PostgreSQL physical-close observation", {
                postgres: started.version,
                scopeClosed: true,
                transportClosed: Option.isSome(physicallyClosed),
                snapshot,
              });
              assert.isTrue(
                Option.isSome(physicallyClosed),
                "native scope completion must not leave its public transport open after the two-second bound",
              );
            }),
          );
        }),
      15_000,
    );

    it.effect(
      "graceful shutdown closes before its grace period without leaving a host timer",
      () =>
        Effect.gen(function* () {
          const started = yield* Postgres;
          const transport = yield* observeNativePgTransport(started);
          const timersBefore = yield* readNativeTimeoutCount;
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

          const context = yield* Scope.provide(
            Layer.build(
              nativePgLayer({
                url: Redacted.make(started.url),
                maxConnections: 1,
                stream: transport.stream,
                applicationName: "graceful-close-subject",
                shutdownTimeout: "30 seconds",
                prepare: false,
              }),
            ),
            scope,
          );

          const sql = Context.get(context, SqlClient.SqlClient);
          assert.deepStrictEqual(
            yield* sql<{ readonly answer: number }>`SELECT 42::integer AS answer`,
            [{ answer: 42 }],
          );
          const closingAt = yield* Clock.monotonicTimeNanos;
          yield* Scope.close(scope, Exit.void);
          yield* transport.closed;
          const finishedAt = yield* Clock.monotonicTimeNanos;
          const elapsedMilliseconds = Number(finishedAt - closingAt) / 1_000_000;
          const timersAfter = yield* readNativeTimeoutCount;
          yield* Effect.logInfo("Native graceful shutdown timer observation", {
            host: yield* readNativeHostRuntime,
            graceMilliseconds: 30_000,
            elapsedMilliseconds,
            timersBefore,
            timersAfter,
          });
          assert.isBelow(
            elapsedMilliseconds,
            2000,
            "graceful close must not wait for the 30-second destruction timer",
          );
          assert.strictEqual(
            timersAfter,
            timersBefore,
            "all shutdown timers must be gone after the real close receipt",
          );
          const snapshot = yield* transport.snapshot;
          assert.strictEqual(snapshot.length, 1);
          const socket = yield* Effect.fromNullishOr(snapshot[0]);
          assert.isTrue(socket.closed && socket.destroyed);
        }),
      10_000,
    );

    it.effect(
      "omitting shutdownTimeout retains synchronous scope completion while FIN is withheld",
      () =>
        Effect.gen(function* () {
          const started = yield* Postgres;

          return yield* withFinWithheldPostgres(started, (endpoint) =>
            Effect.gen(function* () {
              const transport = yield* observeNativePgTransport(endpoint);
              const scope = yield* Scope.make();
              yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

              const context = yield* Scope.provide(
                Layer.build(
                  nativePgLayer({
                    url: Redacted.make(endpoint.url),
                    maxConnections: 1,
                    stream: transport.stream,
                    applicationName: "omitted-close-subject",
                    prepare: false,
                  }),
                ),
                scope,
              );

              const sql = Context.get(context, SqlClient.SqlClient);
              assert.deepStrictEqual(
                yield* sql<{ readonly answer: number }>`SELECT 42::integer AS answer`,
                [{ answer: 42 }],
              );
              const closingAt = yield* Clock.monotonicTimeNanos;
              yield* Scope.close(scope, Exit.void);
              const completedAt = yield* Clock.monotonicTimeNanos;
              assert.isBelow(Number(completedAt - closingAt) / 1_000_000, 250);
              const closed = yield* transport.closed.pipe(Effect.timeoutOption("250 millis"));
              assert.isTrue(
                Option.isNone(closed),
                "omission must not opt into awaiting or forcing a close receipt",
              );
              const snapshot = yield* transport.snapshot;
              assert.deepStrictEqual(
                snapshot.map(({ closed, destroyed }) => ({ closed, destroyed })),
                [{ closed: false, destroyed: false }],
              );
            }),
          );
        }),
      10_000,
    );

    it.effect(
      "a genuine close-silent Duplex defects within grace plus the hard close-ack bound",
      () =>
        Effect.gen(function* () {
          const started = yield* Postgres;
          const transport = yield* observeNativePgTransport(started);
          const closingAt = yield* Ref.make(0n);

          const result = yield* Effect.exit(
            Effect.scoped(
              Effect.gen(function* () {
                // Effect Pool reports item-finalizer defects through reportUnhandledError.
                // Exercise the public connection scope directly to assert this finalizer's failure channel.
                const connection = yield* PgConnection.make({
                  url: Redacted.make(started.url),
                  stream: () => new CloseSilentPgDuplex(transport.stream()),
                  applicationName: "silent-close-subject",
                  shutdownTimeout: "100 millis",
                });

                assert.deepStrictEqual(
                  yield* connection.queryValues("SELECT 42::integer AS answer", [], false),
                  [[42]],
                );
                yield* Ref.set(closingAt, yield* Clock.monotonicTimeNanos);
              }),
            ),
          );

          const finishedAt = yield* Clock.monotonicTimeNanos;
          assert.isTrue(
            Exit.isFailure(result) && Cause.hasDies(result.cause),
            "a missing close receipt must defect rather than succeed",
          );
          const elapsed = Number(finishedAt - (yield* Ref.get(closingAt))) / 1_000_000;
          assert.isAtLeast(
            elapsed,
            200,
            "100ms grace and 100ms hard acknowledgement wait must both run",
          );
          assert.isBelow(elapsed, 1000, "no close event may hang a native scope indefinitely");
          yield* transport.closed;
          assert.isTrue(
            (yield* transport.snapshot).every(({ destroyed, closed }) => destroyed && closed),
            "the real TCP transport was destroyed even though the wrapper emitted no close event",
          );
        }),
      10_000,
    );
  },
);

it.effect("discards native layer construction without reading the supplied configuration", () =>
  Effect.sync(() => {
    let inspected = false;
    nativePgLayer({
      get maxConnections(): number {
        inspected = true;
        throw new Error("configuration was inspected during construction");
      },
    });
    assert.isFalse(inspected);
  }),
);
