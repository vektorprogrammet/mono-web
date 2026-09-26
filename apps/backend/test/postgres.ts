import { startDisposablePostgres } from "@monoweb/postgres";
import { Database } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll } from "vitest";

/** Builds a layer into the current scope with its own memo map, as its own runtime would. */
const buildIsolated = <A, E>(layer: Layer.Layer<A, E>) =>
  Effect.flatMap(Effect.scope, (scope) =>
    Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope),
  );

/** Starts the cluster and opens two independent sessions on its `postgres` database. */
const startCluster = Effect.gen(function* () {
  const cluster = yield* Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ listen: "socket" })),
    (started) => Effect.promise(() => started.stop()),
  );

  const connection = (database: string) =>
    DatabaseLive({
      host: cluster.socketDirectory,
      port: cluster.port,
      database,
      username: "postgres",
      maxConnections: 1,
    }).pipe(Layer.orDie);

  const health = Database.use((sql) => sql.health);
  const primary = yield* buildIsolated(connection("postgres"));
  yield* Effect.provide(health, primary);
  const contender = yield* buildIsolated(connection("postgres"));
  yield* Effect.provide(health, contender);

  // Migrates once per cluster; fixtures clone it instead of replaying every migration.
  const template = yield* Effect.cached(
    Effect.gen(function* () {
      const name = "backend_fixture_template";
      yield* Effect.provide(
        Database.use((sql) => sql`CREATE DATABASE ${sql(name)}`),
        primary,
      );
      yield* Effect.provide(health, connection(name), { local: true });

      return name;
    }),
  );

  let databaseSequence = 0;

  const createDatabase = Effect.gen(function* () {
    const source = yield* template;
    const name = `backend_fixture_${++databaseSequence}`;
    yield* Effect.provide(
      Database.use((sql) => sql`CREATE DATABASE ${sql(name)} TEMPLATE ${sql(source)}`),
      primary,
    );

    return {
      layer: connection(name),
      drop: Effect.provide(
        Database.use((sql) => sql`DROP DATABASE ${sql(name)}`),
        primary,
      ),
    };
  });

  return { primary, contender, createDatabase };
});

class BackendCluster extends Context.Service<
  BackendCluster,
  Effect.Success<typeof startCluster>
>()("apps/backend/test/BackendCluster") {}

/**
 * Independent PostgreSQL sessions on a private Unix socket, with no TCP listener. The cluster
 * belongs to the test file: it starts before the first test and stops after the last.
 */
export const backendPostgres = () => {
  const runtime = ManagedRuntime.make(Layer.effect(BackendCluster, startCluster));
  const cluster = Effect.map(runtime.contextEffect, Context.get(BackendCluster));

  beforeAll(() => runtime.runPromise(Effect.void), 30_000);
  afterAll(() => runtime.dispose(), 30_000);

  return {
    createDatabase: Effect.flatMap(cluster, (started) => started.createDatabase),
    /** Runs on the primary session. */
    run: <A, E>(effect: Effect.Effect<A, E, Database>) =>
      Effect.flatMap(cluster, (started) => Effect.provide(effect, started.primary)),
    /** Runs on a second session, which competes with the primary for locks. */
    compete: <A, E>(effect: Effect.Effect<A, E, Database>) =>
      Effect.flatMap(cluster, (started) => Effect.provide(effect, started.contender)),
  };
};
