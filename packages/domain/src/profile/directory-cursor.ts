import { Effect } from "effect";
import { ProfileDecodeError } from "./errors.js";

const DIRECTORY_CURSOR_VERSION = "v1";

/** Encodes the last sort tuple as an opaque, strictly decodable cursor. */
export const encodeDirectoryCursor = (entry: {
  readonly lastName: string;
  readonly firstName: string;
  readonly personId: string;
}): string =>
  Buffer.from(
    JSON.stringify([DIRECTORY_CURSOR_VERSION, entry.lastName, entry.firstName, entry.personId]),
    "utf8",
  ).toString("base64");

/** Decodes a directory cursor into the canonical keyset tuple. */
export const decodeDirectoryCursor = (
  cursor: string,
): Effect.Effect<{ lastName: string; firstName: string; personId: string }, ProfileDecodeError> =>
  Effect.gen(function* () {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
    } catch {
      return yield* new ProfileDecodeError({ message: "malformed Profile directory cursor" });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== DIRECTORY_CURSOR_VERSION ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string" ||
      typeof parsed[3] !== "string"
    ) {
      return yield* new ProfileDecodeError({ message: "malformed Profile directory cursor" });
    }
    return { lastName: parsed[1], firstName: parsed[2], personId: parsed[3] };
  });
