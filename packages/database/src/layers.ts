import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { Effect, Layer } from "effect";
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
) => DatabaseFromPg(observer).pipe(Layer.provide(PgClient.layer(config)));

export const DatabaseTest = (
  config?: Parameters<typeof PgliteClient.layer>[0],
  observer?: DatabaseLayerObserver,
) => DatabaseFromPglite(observer).pipe(Layer.provide(PgliteClient.layer(config)));
