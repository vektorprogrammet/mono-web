import { Schema } from "effect";

/** Preserve every selected column, including driver-native timestamps and byte strings. */
export const PostgresObservation = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Json, Schema.Date, Schema.Uint8Array]),
);

export type PostgresObservation = typeof PostgresObservation.Type;

/** Decodes the rows of a query, and throws on a row that is no observation. */
export const decodePostgresObservations: (
  rows: ReadonlyArray<unknown>,
) => ReadonlyArray<PostgresObservation> = Schema.decodeUnknownSync(
  Schema.Array(PostgresObservation),
);

/** The query shape that pg `Pool` and `PoolClient` share; `pg` does not resolve from tools/acceptance. */
export type PostgresQueryable = Readonly<{
  query: (
    text: string,
    values?: ReadonlyArray<unknown>,
  ) => Promise<Readonly<{ rows: ReadonlyArray<unknown> }>>;
}>;
