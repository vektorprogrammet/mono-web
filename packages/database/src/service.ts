/**
 * EX-0021: required public native SQL APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Schema, Context, Data, Effect } from "effect";
import type * as Migrator from "effect/sql/Migrator";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Row } from "effect/sql/SqlConnection";
import type * as Statement from "effect/sql/Statement";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

export class DatabaseUnavailable extends Data.TaggedError("DatabaseUnavailable")<{
  readonly operation: "health";
  readonly cause: unknown;
}> {}

/** `Database.migrate` on a runtime whose deployment pipeline owns schema migration. */
export class DatabaseMigrationExternallyManaged extends Data.TaggedError(
  "DatabaseMigrationExternallyManaged",
) {}

/**
 * A value bound as one SQL parameter. The native driver rejects unencoded objects.
 * Bind the encoded value, such as an Instant encoded as RFC 3339 text.
 * JSON values use Database.json. Array predicates use the native SQL helpers.
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
 * The native SqlClient capability with bindable domain parameters and database operations.
 * Inheriting SqlClient preserves its runtime identity, reservations, transforms, and channels.
 * The domain overload documents encoded SQL inputs without erasing the native capability.
 */
export interface DatabaseOperations extends SqlClient.SqlClient {
  <A extends object = Row>(
    strings: TemplateStringsArray,
    ...args: ReadonlyArray<SqlParameter | Statement.Fragment | Statement.Helper>
  ): Statement.Statement<A>;
  (value: string): Statement.Identifier;
  /**
   * Binds a JSON value as one parameter and encodes it here. Pass the value, such as
   * `canonicalJsonValue(x)`, never JSON text: text is stored as a JSON string.
   */
  readonly json: (_: Schema.Json) => Statement.Fragment;
  readonly migrate: Effect.Effect<
    void,
    Migrator.MigrationError | SqlError | DatabaseMigrationExternallyManaged
  >;
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
