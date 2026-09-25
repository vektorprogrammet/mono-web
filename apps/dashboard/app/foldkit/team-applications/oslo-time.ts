import { DateTime, Option } from "effect";

const osloZone = DateTime.zoneMakeNamedUnsafe("Europe/Oslo");

const dateTimeLocalPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/**
 * Reads a `datetime-local` value as Oslo wall-clock time and returns the RFC 3339 instant.
 * Impossible dates and wall-clock times inside a daylight-saving gap or repeated hour are
 * rejected instead of being shifted silently.
 */
export const instantFromOsloDateTimeLocal = (value: string): Option.Option<string> => {
  const match = dateTimeLocalPattern.exec(value);

  if (match === null) return Option.none();

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };

  return DateTime.makeZoned(parts, {
    timeZone: osloZone,
    adjustForTimeZone: true,
    disambiguation: "reject",
  }).pipe(
    Option.filter((zoned) => {
      const local = DateTime.toParts(zoned);

      return (
        local.year === parts.year &&
        local.month === parts.month &&
        local.day === parts.day &&
        local.hour === parts.hour &&
        local.minute === parts.minute &&
        local.second === parts.second
      );
    }),
    Option.map(DateTime.formatIso),
  );
};

/** Renders an instant as the minute-precision Oslo `datetime-local` value. */
export const osloDateTimeLocalFromInstant = (instant: string): string =>
  DateTime.makeZoned(instant, { timeZone: osloZone }).pipe(
    Option.map(DateTime.toParts),
    Option.match({
      onNone: () => "",
      onSome: (local) =>
        `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`,
    }),
  );
