import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { databaseWithMigrations, type DatabaseLayerObserver } from "../database-construction.js";
import { DatabaseMigrationExecutionError, type ExecuteMigration } from "../migrations.js";
import { Database } from "../service.js";

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

      return yield* databaseWithMigrations(executeWithPglite, client.json, observer);
    }),
  );

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

/** In-memory PGlite, migrated like `DatabaseLive`; tests take it on Bun from `test-support/platform`. */
export const DatabaseTest = (
  config?: Parameters<typeof PgliteClient.layer>[0],
  observer?: DatabaseLayerObserver,
) => DatabaseFromPglite(observer).pipe(Layer.provide(PgliteClient.layer(pgliteTestConfig(config))));
