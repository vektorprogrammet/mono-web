import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Option } from "effect";
import * as Statement from "effect/unstable/sql/Statement";
import type * as SqlConnection from "effect/unstable/sql/SqlConnection";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { DatabaseOperations } from "../service.js";

export interface PostgresStatementObserver {
  <A, R>(
    execution: Effect.Effect<A, SqlError, R>,
    text: string,
    parameters: ReadonlyArray<string>,
  ): Effect.Effect<A, SqlError, R>;
}

/** Observe the real driver connection without replacing transaction ownership. */
export const observePostgresStatements = (
  database: DatabaseOperations,
  observe: PostgresStatementObserver,
): DatabaseOperations => {
  const connection = Effect.flatMap(
    Effect.serviceOption(database.transactionService),
    Option.match({
      onNone: () => database.reserve,
      onSome: ([current]) => Effect.succeed(current),
    }),
  ).pipe(
    Effect.map(
      (current): SqlConnection.Connection => ({
        executeStream: (text, parameters, transformRows) =>
          current.executeStream(text, parameters, transformRows),
        execute: (text, parameters, transformRows) =>
          observe(current.execute(text, parameters, transformRows), text, parameters.map(String)),
        executeRaw: (text, parameters) =>
          observe(current.executeRaw(text, parameters), text, parameters.map(String)),
        executeValues: (text, parameters) =>
          observe(current.executeValues(text, parameters), text, parameters.map(String)),
        executeValuesUnprepared: (text, parameters) =>
          observe(current.executeValuesUnprepared(text, parameters), text, parameters.map(String)),
        executeUnprepared: (text, parameters, transformRows) =>
          observe(
            current.executeUnprepared(text, parameters, transformRows),
            text,
            parameters.map(String),
          ),
      }),
    ),
  );

  const statements = Statement.make(connection, PgClient.makeCompiler(), [], undefined);

  return Object.assign(statements, { ...database, ...statements });
};
