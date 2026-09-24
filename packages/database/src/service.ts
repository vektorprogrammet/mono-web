import { Schema, Context, Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";
import { isSqlError } from "effect/unstable/sql/SqlError";

export class DatabaseUnavailable extends Data.TaggedError("DatabaseUnavailable")<{
  readonly operation: "health";
  readonly cause: unknown;
}> {}

export interface DatabaseOperations extends SqlClient.SqlClient {
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
