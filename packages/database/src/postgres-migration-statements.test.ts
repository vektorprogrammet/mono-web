/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { expectTypeOf } from "vitest";
import type { DatabaseMigrationExecutionError, ExecuteMigration } from "./migrations.js";
import {
  executePostgresMigration,
  postgresMigrationStatements,
} from "./postgres-migration-statements.js";

describe("PostgreSQL migration source boundaries", () => {
  it.effect("construction and discard do not parse invalid SQL or acquire SQL", () =>
    Effect.sync(() => {
      expect(() => postgresMigrationStatements("this is invalid SQL")).not.toThrow();
      expect(() => executePostgresMigration("this is invalid SQL")).not.toThrow();
      expectTypeOf<
        Effect.Services<ReturnType<typeof executePostgresMigration>>
      >().toEqualTypeOf<SqlClient.SqlClient>();
      expectTypeOf(postgresMigrationStatements("SELECT 1")).toEqualTypeOf<
        Effect.Effect<ReadonlyArray<string>, DatabaseMigrationExecutionError>
      >();
      expectTypeOf(executePostgresMigration("SELECT 1")).toEqualTypeOf<
        Effect.Effect<void, SqlError | DatabaseMigrationExecutionError, SqlClient.SqlClient>
      >();
      expectTypeOf(executePostgresMigration).toExtend<ExecuteMigration>();
    }),
  );
  it.effect.each([
    { source: "", expected: [] },
    { source: "-- only a comment;\n/* nested /* comment; */ done */", expected: [] },
    { source: "SELECT 1", expected: ["SELECT 1"] },
    { source: "SELECT 1;SELECT 2", expected: ["SELECT 1", "SELECT 2"] },
    {
      source: "/* α */ SELECT /* β; */ 'ø;😀'; -- line;\n SELECT $$a;b$$",
      expected: ["SELECT /* β; */ 'ø;😀'", "SELECT $$a;b$$"],
    },
    {
      source: "SELECT E'escaped\\\';semicolon'; SELECT '終' -- last comment",
      expected: ["SELECT E'escaped\\\';semicolon'", "SELECT '終' -- last comment"],
    },
    {
      source:
        "CREATE FUNCTION public.quoted() RETURNS text LANGUAGE plpgsql AS $body$ BEGIN RETURN 'α;😀'; END $body$; SELECT public.quoted()",
      expected: [
        "CREATE FUNCTION public.quoted() RETURNS text LANGUAGE plpgsql AS $body$ BEGIN RETURN 'α;😀'; END $body$",
        "SELECT public.quoted()",
      ],
    },
  ])("keeps parser UTF-8 offsets, zero defaults and dollar quotes %#", ({ source, expected }) =>
    Effect.gen(function* () {
      expect(yield* postgresMigrationStatements(source)).toEqual(expected);
    }),
  );
  it.effect.each(["SELECT (", "SELECT 1\0; SELECT 2"])(
    "fails invalid input without partial execution %#",
    (source) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(postgresMigrationStatements(source));
        expect(error._tag).toBe("DatabaseMigrationExecutionError");
      }),
  );
});
