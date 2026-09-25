import { Schema } from "effect";

/** Preserve every selected column, including driver-native timestamps and byte strings. */
export const PostgresObservation = Schema.Record(
  Schema.String,
  Schema.Union([Schema.Json, Schema.Date, Schema.Uint8Array]),
);

export type PostgresObservation = typeof PostgresObservation.Type;

export const decodePostgresObservations = Schema.decodeUnknownSync(
  Schema.Array(PostgresObservation),
);
