import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { schemaBookkeepingTables } from "./schema-bookkeeping.js";
import { Database } from "./service.js";
import { DatabaseTestLive } from "./test-support/platform.js";

const qualified = ({ schema, table }: { readonly schema: string; readonly table: string }) =>
  `${schema}.${table}`;

layer(DatabaseTestLive(), { excludeTestServices: true, timeout: "30 seconds" })(
  "schema bookkeeping tables",
  (it) => {
    it.effect(
      "declares every table that a freshly built database fills, and each declared table exists",
      () =>
        Effect.gen(function* () {
          const database = yield* Database;

          const tables = yield* database<{ readonly schema: string; readonly table: string }>`
            SELECT schemaname AS "schema", tablename AS "table"
            FROM pg_catalog.pg_tables
            WHERE schemaname IN ('public', 'auth')
            ORDER BY schemaname, tablename
          `;

          const occupied = yield* Effect.filter(
            tables,
            ({ schema, table }) =>
              Effect.map(
                database<{ readonly occupied: boolean }>`
                  SELECT EXISTS (SELECT 1 FROM ${database(schema)}.${database(table)}) AS occupied
                `,
                (rows) => rows[0]?.occupied === true,
              ),
            { concurrency: 1 },
          );

          const declared = new Set(schemaBookkeepingTables.map(qualified));
          const existing = new Set(tables.map(qualified));

          expect(occupied.map(qualified).filter((name) => !declared.has(name))).toEqual([]);
          expect([...declared].filter((name) => !existing.has(name))).toEqual([]);
        }),
    );
  },
);
