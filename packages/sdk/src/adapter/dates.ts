/**
 * ISO date string -> Date parsing for Schema.transform pipelines.
 */

import { Schema } from "effect"

/**
 * Schema transform: ISO date string from API -> JavaScript Date.
 * Accepts full ISO 8601 ("2026-01-10T12:00:00+01:00") or date-only ("2026-01-10").
 */
export const DateFromIso = Schema.transform(
  Schema.String,
  Schema.DateFromSelf,
  {
    decode: (s) => new Date(s),
    encode: (d) => d.toISOString(),
  },
)

/**
 * Nullable variant -- null stays null, string becomes Date.
 */
export const NullableDateFromIso = Schema.transform(
  Schema.NullOr(Schema.String),
  Schema.NullOr(Schema.DateFromSelf),
  {
    decode: (s) => (s === null ? null : new Date(s)),
    encode: (d) => (d === null ? null : d.toISOString()),
  },
)
