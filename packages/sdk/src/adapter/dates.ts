/**
 * ISO date string -> Date parsing for Schema.decodeTo pipelines.
 */

import { Schema, SchemaGetter } from "effect"

const ValidIsoDateString = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) => !Number.isNaN(new Date(value).getTime()),
      { message: "a valid ISO date string" },
    ),
  ),
)

/**
 * Schema transform: ISO date string from API -> JavaScript Date.
 * Accepts full ISO 8601 ("2026-01-10T12:00:00+01:00") or date-only ("2026-01-10").
 * Invalid dates are rejected before the Date representation is constructed.
 */
export const DateFromIso = ValidIsoDateString.pipe(
  Schema.decodeTo(Schema.Date, {
    decode: SchemaGetter.transform((s: string) => new Date(s)),
    encode: SchemaGetter.transform((d: Date) => d.toISOString()),
  }),
)

/**
 * Nullable variant -- null stays null, string becomes Date.
 */
export const NullableDateFromIso = Schema.NullOr(ValidIsoDateString).pipe(
  Schema.decodeTo(Schema.NullOr(Schema.Date), {
    decode: SchemaGetter.transform((s: string | null) => (s === null ? null : new Date(s))),
    encode: SchemaGetter.transform((d: Date | null) => (d === null ? null : d.toISOString())),
  }),
)
