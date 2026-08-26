import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { Context, Duration, Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  Database,
  type DatabaseShape,
  DatabaseUnavailable,
} from "@vektorprogrammet/domain/database";
import {
  DatabaseMigrationExecutionError,
  databaseSchemaRevision,
  type ExecuteMigration,
  runDatabaseMigrations,
} from "./migrations.js";

export interface DatabaseLayerObserver {
  readonly onAcquire: () => void;
  readonly onMigration: () => void;
  readonly onRelease: () => void;
}

/** The one native PostgreSQL pool shared by Database and Better Auth. */
export class DatabasePgPool extends Context.Service<DatabasePgPool, Pool>()(
  "@vektorprogrammet/database/DatabasePgPool",
) {}

const makeSharedPgPool = (config: Parameters<typeof PgClient.layer>[0]) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const pool = new Pool({
        connectionString: config.url === undefined ? undefined : Redacted.value(config.url),
        user: config.username,
        host: config.host,
        database: config.database,
        password: config.password === undefined ? undefined : Redacted.value(config.password),
        ssl: config.ssl,
        port: config.port,
        ...(config.stream === undefined ? {} : { stream: config.stream }),
        connectionTimeoutMillis:
          config.connectTimeout === undefined
            ? undefined
            : Duration.toMillis(Duration.fromInputUnsafe(config.connectTimeout)),
        idleTimeoutMillis:
          config.idleTimeout === undefined
            ? undefined
            : Duration.toMillis(Duration.fromInputUnsafe(config.idleTimeout)),
        max: config.maxConnections,
        min: config.minConnections,
        maxLifetimeSeconds:
          config.connectionTTL === undefined
            ? undefined
            : Duration.toSeconds(Duration.fromInputUnsafe(config.connectionTTL)),
        application_name: config.applicationName ?? "@effect/sql-pg",
        options: "-c search_path=auth,public",
        types: config.types,
      });
      pool.on("error", () => {});
      return pool;
    }),
    (pool) =>
      Effect.promise(() => pool.end()).pipe(
        Effect.timeoutOption(Duration.seconds(1)),
        Effect.ignore,
      ),
  );

const sharedPgLayer = (config: Parameters<typeof PgClient.layer>[0]) => {
  const poolLayer = Layer.effect(DatabasePgPool, makeSharedPgPool(config));
  const clientLayer = PgClient.layerFrom(
    Effect.gen(function* () {
      const pool = yield* DatabasePgPool;
      return yield* PgClient.fromPool({ ...config, acquire: Effect.succeed(pool) });
    }),
  );
  return clientLayer.pipe(Layer.provideMerge(poolLayer));
};

const makeDatabase = (
  executeMigration: ExecuteMigration,
  json: DatabaseShape["json"],
  observer?: DatabaseLayerObserver,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (observer !== undefined) {
      yield* Effect.sync(observer.onAcquire);
      yield* Effect.addFinalizer(() => Effect.sync(observer.onRelease));
    }
    const migrate = runDatabaseMigrations(executeMigration).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.asVoid,
    );
    yield* migrate;
    if (observer !== undefined) yield* Effect.sync(observer.onMigration);
    return Database.of(
      Object.assign(sql, {
        json,
        migrate,
        schemaRevision: databaseSchemaRevision,
        health: sql`SELECT 1 AS ready`.pipe(
          Effect.asVoid,
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(new DatabaseUnavailable({ operation: "health", cause })),
          ),
        ),
      }),
    );
  });

const executeWithSql: ExecuteMigration = (source) =>
  SqlClient.SqlClient.use((sql) => sql.unsafe(source).pipe(Effect.asVoid));

const DatabaseFromPg = (observer?: DatabaseLayerObserver) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient;
      return yield* makeDatabase(executeWithSql, client.json, observer);
    }),
  );

const DatabaseFromPglite = (observer?: DatabaseLayerObserver) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* PgliteClient.PgliteClient;
      const executeWithPglite: ExecuteMigration = (source) =>
        SqlClient.SqlClient.pipe(
          Effect.andThen(
            Effect.tryPromise({
              // Migrator invokes this inside SqlClient.withTransaction, whose PGlite
              // transaction holds the client's semaphore around this multi-command exec.
              try: () => client.pglite.exec(source),
              catch: (cause) => new DatabaseMigrationExecutionError({ cause }),
            }).pipe(Effect.asVoid),
          ),
        );
      return yield* makeDatabase(executeWithPglite, client.json, observer);
    }),
  );

export const DatabaseLive = (
  config: Parameters<typeof PgClient.layer>[0],
  observer?: DatabaseLayerObserver,
) => DatabaseFromPg(observer).pipe(Layer.provideMerge(sharedPgLayer(config)));

const pgliteTestConfig = (
  config?: Parameters<typeof PgliteClient.layer>[0],
): Parameters<typeof PgliteClient.layer>[0] => {
  if (config !== undefined && "liveClient" in config) return config;
  return {
    ...config,
    extensions: {
      btree_gist,
      ...config?.extensions,
    },
  };
};

export const DatabaseTest = (
  config?: Parameters<typeof PgliteClient.layer>[0],
  observer?: DatabaseLayerObserver,
) => DatabaseFromPglite(observer).pipe(Layer.provide(PgliteClient.layer(pgliteTestConfig(config))));
