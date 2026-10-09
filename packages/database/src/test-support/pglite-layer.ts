/**
 * EX-0021: required stable native SQL APIs retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { types, type ParserOptions } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { databaseWithMigrations, type DatabaseLayerObserver } from "../database-construction.js";
import { DatabaseMigrationExecutionError, type ExecuteMigration } from "../migrations.js";
import { Database } from "../service.js";

const DatabaseFromPglite = (observer?: DatabaseLayerObserver) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* PgliteClient.PgliteClient;

      const executeWithPglite: ExecuteMigration = (source) =>
        SqlClient.SqlClient.pipe(
          Effect.andThen(
            Effect.tryPromise({
              // Migrator invokes this inside SqlClient.withTransaction, whose PGlite
              // transaction holds the client's semaphore around this multi-command exec.
              try: () => client.pglite.exec(source),
              catch: (cause) => new DatabaseMigrationExecutionError({ cause }),
            }).pipe(Effect.asVoid),
          ),
        );

      return yield* databaseWithMigrations(executeWithPglite, client.json, observer);
    }),
  );

const MICROSECONDS_PER_SECOND = 1_000_000n;

/**
 * Microseconds since midnight of a PostgreSQL `time` text (`HH:MM:SS[.ffffff]`, `24:00:00` included).
 * Total over the text that PostgreSQL prints for a `time`.
 */
const timeMicroseconds = (text: string): bigint => {
  const [clock = "", fraction = ""] = text.split(".");
  const [hours = "0", minutes = "0", seconds = "0"] = clock.split(":");

  const wholeSeconds = (BigInt(hours) * 60n + BigInt(minutes)) * 60n + BigInt(seconds);

  return wholeSeconds * MICROSECONDS_PER_SECOND + BigInt(fraction.padEnd(6, "0").slice(0, 6));
};

const bigintText = (text: string): bigint => BigInt(text);

const verbatimText = (text: string): string => text;

/**
 * The value types of the native `@effect/sql-pg` 4.0.0 codec table (`PgTypes.ts`, binary format),
 * for the types where PGlite's defaults differ:
 *
 * - `int8` is always a `bigint` (PGlite returns a number up to 2^53 - 1; `PgTypes.ts:1249-1262`).
 * - `date` is the string `YYYY-MM-DD` (PGlite returns a `Date`; `PgTypes.ts:1092-1103`).
 * - `time` is a `bigint` of microseconds since midnight (PGlite returns the text; `PgTypes.ts:1294-1308`).
 *
 * Array types follow their element type, as `PgTypes.ts:346-369` registers them.
 * `regclass` stays unmirrored: the native codec decodes the OID (`PgTypes.ts:1248`) and PGlite sends
 * only the name, so no text parser can recover it. Code reads `regclass` through `::text`.
 * `pglite-native-parity.test.ts` pins every entry against the native codec.
 */
export const nativeValueParsers: ParserOptions = {
  [types.INT8]: bigintText,
  1016: (text) => types.arrayParser(text, bigintText, 1016),
  [types.DATE]: verbatimText,
  1182: (text) => types.arrayParser(text, verbatimText, 1182),
  [types.TIME]: timeMicroseconds,
  1183: (text) => types.arrayParser(text, timeMicroseconds, 1183),
};

const pgliteTestConfig = (
  config?: Parameters<typeof PgliteClient.layer>[0],
): Parameters<typeof PgliteClient.layer>[0] => {
  if (config !== undefined && "liveClient" in config) return config;

  return {
    ...config,
    parsers: { ...nativeValueParsers, ...config?.parsers },
    extensions: {
      btree_gist,
      ...config?.extensions,
    },
  };
};

/**
 * In-memory PGlite, migrated like `DatabaseLive`; tests take it on Bun from `test-support/platform`.
 * Rows carry the value types of the native client (`nativeValueParsers`), so an uncast int8, date, or
 * time fails here as it does on PostgreSQL. A caller-supplied `parsers` entry overrides one type.
 */
export const DatabaseTest = (
  config?: Parameters<typeof PgliteClient.layer>[0],
  observer?: DatabaseLayerObserver,
) => DatabaseFromPglite(observer).pipe(Layer.provide(PgliteClient.layer(pgliteTestConfig(config))));
