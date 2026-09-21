import { Context, Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

export class DatabaseUnavailable extends Data.TaggedError("DatabaseUnavailable")<{
  readonly operation: "health";
  readonly cause: unknown;
}> {}

export interface DatabaseShape extends SqlClient.SqlClient {
  readonly json: (_: unknown) => Statement.Fragment;
  readonly migrate: Effect.Effect<void, unknown>;
  readonly schemaRevision: string;
  readonly health: Effect.Effect<void, DatabaseUnavailable>;
}

export class Database extends Context.Service<Database, DatabaseShape>()(
  "@vektorprogrammet/Database",
) {}

export const databaseHealth = Database.use((database) => database.health);
