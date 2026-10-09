/**
 * EX-0021: required public native SQL APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import { Schema, Data, Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { nativePgLayer, type NativePgPoolConfig } from "./pg-pool.js";
import {
  Database,
  DatabaseMigrationExternallyManaged,
  DatabaseUnavailable,
  withTypedTransactionFailures,
} from "./service.js";

export class DatabaseExternalSchemaUnavailable extends Data.TaggedError(
  "DatabaseExternalSchemaUnavailable",
) {}

/**
 * PostgreSQL runtime for hosts whose deployment pipeline owns schema migration.
 * Acquisition verifies and reports the schema revision already present in the
 * database; application processes cannot mutate it through Database.migrate.
 */
export const DatabaseRuntimeLive = (config: NativePgPoolConfig) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient;
      const json = client.json;
      const sql = yield* SqlClient.SqlClient;

      const revisions = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT migration_id AS "migrationId", name
        FROM vektorprogrammet_schema_migrations
        ORDER BY migration_id DESC
        LIMIT 1
      `;

      const revision = revisions[0];

      if (revision === undefined) return yield* new DatabaseExternalSchemaUnavailable();

      return Database.of(
        Object.assign(sql, {
          withTransaction: withTypedTransactionFailures(sql.withTransaction),
          json: (value: Schema.Json) => json(value),
          migrate: Effect.fail(new DatabaseMigrationExternallyManaged()),
          schemaRevision: `${revision.migrationId}_${revision.name}`.replaceAll("-", "_"),
          health: sql`SELECT 1 AS ready`.pipe(
            Effect.asVoid,
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(new DatabaseUnavailable({ operation: "health", cause })),
            ),
          ),
        }),
      );
    }),
  ).pipe(Layer.provideMerge(nativePgLayer(config)));
