/**
 * EX-0021: required public native SQL APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer } from "effect";
import { executePostgresMigration } from "./postgres-migration-statements.js";
import { databaseWithMigrations, type DatabaseLayerObserver } from "./database-construction.js";
import { nativePgLayer, type NativePgPoolConfig } from "./pg-pool.js";
import { Database } from "./service.js";

export type { DatabaseLayerObserver } from "./database-construction.js";

const DatabaseFromPg = (observer?: DatabaseLayerObserver) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient;
      const json = client.json;

      return yield* databaseWithMigrations(executePostgresMigration, json, observer);
    }),
  );

/**
 * PostgreSQL through its native pool, migrated when the layer is built.
 * The composition root supplies FileSystem and Path for the migration reader.
 * Better Auth owns a separate supported pool.
 */
export const DatabaseLive = (config: NativePgPoolConfig, observer?: DatabaseLayerObserver) =>
  DatabaseFromPg(observer).pipe(Layer.provideMerge(nativePgLayer(config)));
