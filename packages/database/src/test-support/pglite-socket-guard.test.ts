import { expect, layer } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Result } from "effect";
import { TestPlatform } from "./platform.js";
import {
  makeErrorFrameScanner,
  PgliteSocketRejectedStatement,
  withPostgresTestDatabase,
  withRealPostgres,
} from "./postgres.js";

const createTable = "CREATE TABLE guard_probe(a int PRIMARY KEY)";

const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.findDefect(exit.cause) : Result.fail(undefined);

/** One ErrorResponse frame: severity, SQLSTATE and message fields, then the terminator. */
const errorFrame = (sqlState: string, message: string) => {
  const encoder = new TextEncoder();

  const body = [
    ...encoder.encode("SERROR"),
    0,
    ...encoder.encode(`C${sqlState}`),
    0,
    ...encoder.encode(`M${message}`),
    0,
    0,
  ];

  const length = body.length + 4;

  return Uint8Array.from([
    0x45,
    length >>> 24,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
    ...body,
  ]);
};

const readyForQuery = Uint8Array.from([0x5a, 0, 0, 0, 5, 0x49]);

layer(TestPlatform, { excludeTestServices: true })(
  "PGlite socket rejected-statement guard",
  (it) => {
    it("reads an ErrorResponse across arbitrary chunk boundaries and ignores other frames", () => {
      const stream = Uint8Array.from([
        ...readyForQuery,
        ...errorFrame("23505", "duplicate key"),
        ...readyForQuery,
        ...errorFrame("P0001", "history insert rejected"),
      ]);

      for (const size of [1, 2, 5, 7, stream.length]) {
        const seen: Array<readonly [string, string]> = [];

        const scan = makeErrorFrameScanner((rejection) => {
          seen.push([rejection.sqlState, rejection.detail]);
        });

        for (let offset = 0; offset < stream.length; offset += size)
          scan(stream.slice(offset, offset + size));

        expect(seen).toEqual([
          ["23505", "duplicate key"],
          ["P0001", "history insert rejected"],
        ]);
      }
    });

    it.effect("ends a test that handles a rejected statement with the typed defect", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          withPostgresTestDatabase((sql) =>
            Effect.gen(function* () {
              yield* sql.unsafe(createTable);
              yield* sql.unsafe("INSERT INTO guard_probe VALUES (1)");
              // The test handles the SQL failure and goes on: the guard still ends it.
              yield* Effect.exit(sql.unsafe("INSERT INTO guard_probe VALUES (1)"));

              return yield* Effect.never;
            }),
          ),
        );

        const defect = defectOf(exit);

        expect(Result.isSuccess(defect) && defect.success).toBeInstanceOf(
          PgliteSocketRejectedStatement,
        );
        expect(Result.isSuccess(defect) && defect.success).toMatchObject({ sqlState: "23505" });
      }),
    );

    it.effect("ends a rolled-back transaction whose statement failed with the typed defect", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          withPostgresTestDatabase((sql) =>
            Effect.gen(function* () {
              yield* sql.unsafe(createTable);

              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe("INSERT INTO guard_probe VALUES (1)");

                  return yield* sql.unsafe("INSERT INTO guard_probe VALUES (1)");
                }),
              );
            }),
          ),
        );

        const defect = defectOf(exit);

        expect(Result.isSuccess(defect) && defect.success).toBeInstanceOf(
          PgliteSocketRejectedStatement,
        );
        expect(Result.isSuccess(defect) && defect.success).toMatchObject({ sqlState: "23505" });
      }),
    );

    it.effect(
      "lets a domain failure and an interruption roll a healthy transaction back, and a server-side caught error pass",
      () =>
        withPostgresTestDatabase((sql) =>
          Effect.gen(function* () {
            yield* sql.unsafe(createTable);
            yield* sql.unsafe(`
            CREATE FUNCTION guard_attempt() RETURNS text LANGUAGE plpgsql AS $$
            BEGIN
              BEGIN INSERT INTO guard_probe VALUES (7), (7); RETURN 'accepted';
              EXCEPTION WHEN unique_violation THEN RETURN 'refused'; END;
            END $$`);

            const failure = yield* Effect.flip(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe("INSERT INTO guard_probe VALUES (2)");

                  return yield* Effect.fail("domain" as const);
                }),
              ),
            );

            expect(failure).toBe("domain");

            const written = yield* Deferred.make<void>();

            const fiber = yield* Effect.forkChild(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe("INSERT INTO guard_probe VALUES (3)");
                  yield* Deferred.succeed(written, undefined);

                  return yield* Effect.never;
                }),
              ),
            );

            yield* Deferred.await(written);
            yield* Fiber.interrupt(fiber);

            expect(yield* sql.unsafe("SELECT count(*)::int AS n FROM guard_probe")).toEqual([
              { n: 0 },
            ]);
            expect(yield* sql.unsafe("SELECT guard_attempt() AS result")).toEqual([
              { result: "refused" },
            ]);
          }),
        ),
      60_000,
    );

    it.effect(
      "carries the same rejected statement and rollback on real PostgreSQL, where the guard does not apply",
      () =>
        withRealPostgres("pglite-guard-control", (sql) =>
          Effect.gen(function* () {
            yield* sql.unsafe(createTable);

            const failure = yield* Effect.flip(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe("INSERT INTO guard_probe VALUES (1)");

                  return yield* sql.unsafe("INSERT INTO guard_probe VALUES (1)");
                }),
              ),
            );

            expect(failure.reason._tag).toBe("UniqueViolation");
            expect(yield* sql.unsafe("SELECT count(*)::int AS n FROM guard_probe")).toEqual([
              { n: 0 },
            ]);
          }),
        ),
      60_000,
    );
  },
);
