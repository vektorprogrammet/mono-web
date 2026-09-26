// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0008: Effect FileSystem.open has no O_NOFOLLOW; the cohort reader refuses a symlink at open time
import { constants, open } from "node:fs/promises";
import { Effect, Schema } from "effect";

export const parseDisposableCohortDatabaseUrl = (
  value: string | undefined,
  pathnamePattern: RegExp,
  invalid: () => Error,
): string => {
  try {
    const url = new URL(value!);

    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      !pathnamePattern.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw invalid();

    return url.toString();
  } catch (cause) {
    throw cause instanceof Error && cause.message === "InvalidSnapshot" ? cause : invalid();
  }
};

const decodeCohortJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

/**
 * Reads the JSON of a private cohort file: a regular file of the current user with no group or
 * other permission and at most `maxBytes` long, opened without following a symlink. Every other
 * file, and text that is not JSON, fails with `invalid()`.
 */
export const readPrivateCohortJson = <E>(
  path: string | undefined,
  invalid: () => E,
  maxBytes = 1_048_576,
): Effect.Effect<Schema.Json, E> => {
  const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: invalid });

  if (!path) return Effect.fail(invalid());

  return Effect.acquireUseRelease(
    attempt(() => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)),
    (file) =>
      Effect.gen(function* () {
        const stat = yield* attempt(() => file.stat());

        if (
          !stat.isFile() ||
          stat.size > maxBytes ||
          (stat.mode & 0o077) !== 0 ||
          stat.uid !== process.getuid?.()
        )
          return yield* Effect.fail(invalid());

        const text = yield* attempt(() => file.readFile("utf8"));

        return yield* decodeCohortJson(text).pipe(Effect.mapError(invalid));
      }),
    (file) => attempt(() => file.close()),
  );
};

const CohortReportJson = Schema.fromJsonString(Schema.Unknown);

/** Writes a cohort report to standard output as one line, byte for byte what `JSON.stringify` writes. */
export const writeCohortReport = <A>(report: A) =>
  Schema.encodeEffect(CohortReportJson)(report).pipe(
    Effect.flatMap((text) => Effect.sync(() => process.stdout.write(`${text}\n`))),
    Effect.asVoid,
  );
