import { DateTime, Option, Schema } from "effect";

const Rfc3339InstantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Uses Effect DateTime as the parser and rejects its calendar normalization.
 * The adjusted parts must equal the caller-supplied local date and time.
 */
export const isRfc3339Instant = (value: string): boolean => {
  const match = Rfc3339InstantPattern.exec(value);
  if (match === null) return false;
  const parts = (() => {
    if (value.endsWith("Z")) {
      const parsed = DateTime.make(value);
      return Option.isSome(parsed) ? DateTime.toPartsUtc(parsed.value) : undefined;
    }
    const parsed = DateTime.makeZonedFromString(value);
    return Option.isSome(parsed) ? DateTime.toParts(parsed.value) : undefined;
  })();
  if (parts === undefined) return false;
  return (
    parts.year === Number(match[1]) &&
    parts.month === Number(match[2]) &&
    parts.day === Number(match[3]) &&
    parts.hour === Number(match[4]) &&
    parts.minute === Number(match[5]) &&
    parts.second === Number(match[6])
  );
};

export const compareRfc3339Instants = (left: string, right: string): -1 | 0 | 1 => {
  const leftMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(left));
  const rightMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(right));
  return leftMilliseconds < rightMilliseconds ? -1 : leftMilliseconds > rightMilliseconds ? 1 : 0;
};

export const normalizeRfc3339Instant = (value: string): string =>
  DateTime.formatIso(DateTime.makeUnsafe(value));

export const Rfc3339InstantSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isRfc3339Instant, {
      message: "an RFC 3339 instant with an explicit UTC offset",
    }),
  ),
);
