import { Effect, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  databaseSchemaRevision,
  type ExecuteMigration,
  runDatabaseMigrations,
} from "./migrations.js";
import {
  Database,
  type DatabaseOperations,
  DatabaseUnavailable,
  withTypedTransactionFailures,
} from "./service.js";

export interface DatabaseLayerObserver {
  readonly onAcquire: () => void;
  readonly onMigration: () => void;
  readonly onRelease: () => void;
}

export const databaseWithMigrations = (
  executeMigration: ExecuteMigration,
  json: DatabaseOperations["json"],
  observer?: DatabaseLayerObserver,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (observer !== undefined) {
      yield* Effect.sync(observer.onAcquire);
      yield* Effect.addFinalizer(() => Effect.sync(observer.onRelease));
    }

    // `migrate` has no requirement: it reads the migration files through the services of the build.
    const migrate = runDatabaseMigrations(executeMigration).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
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
