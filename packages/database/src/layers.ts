import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  Database,
  type DatabaseOperations,
  DatabaseUnavailable,
  withTypedTransactionFailures,
} from "./service.js";
import {
  DatabaseMigrationExecutionError,
  databaseSchemaRevision,
  type ExecuteMigration,
  runDatabaseMigrations,
} from "./migrations.js";
import { sharedPgLayer } from "./pg-pool.js";

export { DatabasePgPool } from "./pg-pool.js";

export interface DatabaseLayerObserver {
  readonly onAcquire: () => void;
  readonly onMigration: () => void;
  readonly onRelease: () => void;
}

const makeDatabase = (
  executeMigration: ExecuteMigration,
  json: DatabaseOperations["json"],
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

    const database = Database.of(
      Object.assign(sql, {
        withTransaction: withTypedTransactionFailures(sql.withTransaction),
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

    yield* migrate;

    if (observer !== undefined) yield* Effect.sync(observer.onMigration);

    return database;
  });

const executeWithSql: ExecuteMigration = (source) =>
  SqlClient.SqlClient.use((sql) => sql.unsafe(source).pipe(Effect.asVoid));

const DatabaseFromPg = (observer?: DatabaseLayerObserver) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient;
      const json = client.json;

      return yield* makeDatabase(executeWithSql, (value) => json(JSON.stringify(value)), observer);
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
