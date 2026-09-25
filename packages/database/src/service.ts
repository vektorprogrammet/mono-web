import { Schema, Context, Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Row } from "effect/unstable/sql/SqlConnection";
import type * as Statement from "effect/unstable/sql/Statement";
import { isSqlError } from "effect/unstable/sql/SqlError";

export class DatabaseUnavailable extends Data.TaggedError("DatabaseUnavailable")<{
  readonly operation: "health";
  readonly cause: unknown;
}> {}

/**
 * A value bound as one SQL parameter. node-postgres serializes any other object with
 * `JSON.stringify`, so a DateTime, Option, or Redacted would bind its JSON text: bind the
 * encoded value instead, such as an `Instant` encoded as RFC 3339 text.
 */
export type SqlParameter =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | null
  | undefined
  | ReadonlyArray<SqlParameter>;

/**
 * SqlClient whose tagged template accepts only bindable parameters, fragments, and helpers.
 * The mapped base drops SqlClient's template signature, which accepts any argument; the
 * narrower signature still lets a DatabaseOperations stand in wherever a SqlClient is expected.
 */
export interface DatabaseOperations extends Omit<SqlClient.SqlClient, never> {
  <A extends object = Row>(
    strings: TemplateStringsArray,
    ...args: ReadonlyArray<SqlParameter | Statement.Fragment | Statement.Helper>
  ): Statement.Statement<A>;
  (value: string): Statement.Identifier;
  readonly json: (_: Schema.Json) => Statement.Fragment;
  readonly migrate: Effect.Effect<void, unknown>;
  readonly schemaRevision: string;
  readonly health: Effect.Effect<void, DatabaseUnavailable>;
}

export class Database extends Context.Service<Database, DatabaseOperations>()(
  "@vektorprogrammet/Database",
) {}

export const databaseHealth = Database.use((database) => database.health);

/** Keep transaction SQL failures typed without converting unrelated defects. */
export const withTypedTransactionFailures =
  (transaction: SqlClient.SqlClient["withTransaction"]): SqlClient.SqlClient["withTransaction"] =>
  (effect) =>
    transaction(effect).pipe(
      Effect.catchDefect((cause) => (isSqlError(cause) ? Effect.fail(cause) : Effect.die(cause))),
    );
