import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer, Predicate } from "effect";
import { dual } from "effect/Function";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { databaseWithMigrations, type DatabaseLayerObserver } from "./database-construction.js";
import { sharedPgLayer } from "./pg-pool.js";
import { Database } from "./service.js";

export { DatabasePgPool } from "./pg-pool.js";

export type { DatabaseLayerObserver } from "./database-construction.js";

const executeWithSql = (source: string) =>
  SqlClient.SqlClient.use((sql) => sql.unsafe(source).pipe(Effect.asVoid));

const DatabaseFromPg = (observer?: DatabaseLayerObserver) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient;
      const json = client.json;

      return yield* databaseWithMigrations(
        executeWithSql,
        (value) => json(JSON.stringify(value)),
        observer,
      );
    }),
  );

const makeDatabaseLive = (
  config: Parameters<typeof PgClient.layer>[0],
  observer?: DatabaseLayerObserver,
) => DatabaseFromPg(observer).pipe(Layer.provideMerge(sharedPgLayer(config)));

type DatabaseLiveLayer = ReturnType<typeof makeDatabaseLive>;

/**
 * PostgreSQL through the shared pool, migrated to the head revision when the layer is built. It
 * requires `FileSystem` and `Path`, which read the migration files; the composition root selects
 * their platform.
 */
export const DatabaseLive: {
  (
    observer?: DatabaseLayerObserver,
  ): (config: Parameters<typeof PgClient.layer>[0]) => DatabaseLiveLayer;
  (
    config: Parameters<typeof PgClient.layer>[0],
    observer?: DatabaseLayerObserver,
  ): DatabaseLiveLayer;
} = dual(
  (args) => args.length > 0 && !Predicate.hasProperty(args[0], "onAcquire"),
  makeDatabaseLive,
);
