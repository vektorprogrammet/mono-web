/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { DatabaseMigrationExecutionError } from "./migrations.js";

const offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const decodeOffsets = Schema.decodeUnknownEffect(
  Schema.Struct({
    stmts: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          stmt_location: Schema.optionalKey(offset),
          stmt_len: Schema.optionalKey(offset),
        }),
      ),
    ),
  }),
);

/**
 * Parses PostgreSQL statements without rewriting their original UTF-8 bytes.
 * Execution starts only when the Effect runs. libpg-query owns its WASM memory;
 * parsing cannot be aborted, but a cancelled caller never executes a late result.
 * The parser omits protobuf zero defaults: location zero starts at byte zero,
 * and a zero final length means the remainder of the original source.
 * No SQL is executed and no transaction or runtime is acquired here.
 */
export const postgresMigrationStatements = Effect.fnUntraced(function* (
  source: string,
): Effect.fn.Return<ReadonlyArray<string>, DatabaseMigrationExecutionError> {
  if (source.length === 0) return [];

  // PostgreSQL's C parser would otherwise silently truncate at NUL.
  if (source.includes("\0")) {
    return yield* new DatabaseMigrationExecutionError({ cause: "NUL in PostgreSQL migration" });
  }

  // EX-0030: maintained PostgreSQL parser FFI; Effect has no PostgreSQL grammar parser.
  const parsed = yield* Effect.tryPromise({
    try: () => import("libpg-query").then((parser) => parser.parse(source)),
    catch: (cause) => new DatabaseMigrationExecutionError({ cause }),
  });

  const offsets = yield* decodeOffsets(parsed).pipe(
    Effect.mapError((cause) => new DatabaseMigrationExecutionError({ cause })),
  );

  const bytes = new TextEncoder().encode(source);
  const decoder = new TextDecoder("utf-8", { fatal: true });

  return yield* Effect.try({
    try: () =>
      (offsets.stmts ?? []).map((statement) => {
        const start = statement.stmt_location ?? 0;
        const length = statement.stmt_len ?? 0;

        return decoder.decode(bytes.subarray(start, length === 0 ? bytes.length : start + length));
      }),
    catch: (cause) => new DatabaseMigrationExecutionError({ cause }),
  });
});

/**
 * Executes parsed statements sequentially on the provided native SQL client.
 * The caller (normally Migrator) owns the transaction; this operation never
 * commits, opens another pool, retries, or catches SQL failures. Interruption
 * stops subsequent statements and leaves rollback to that transaction owner.
 */
export const executePostgresMigration = Effect.fnUntraced(function* (
  source: string,
): Effect.fn.Return<void, SqlError | DatabaseMigrationExecutionError, SqlClient.SqlClient> {
  const statements = yield* postgresMigrationStatements(source);
  const sql = yield* SqlClient.SqlClient;

  for (const statement of statements) yield* sql.unsafe(statement);
});
