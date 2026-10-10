/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { expect, layer } from "@effect/vitest";
import * as PgTypes from "@effect/sql-pg/PgTypes";
import { types } from "@electric-sql/pglite";
import { DateTime, Effect } from "effect";
import { Database } from "../service.js";
import { DatabaseTestLive } from "./platform.js";

/**
 * `DatabaseTest` (in-process PGlite) must hand back the value types that the native
 * `@effect/sql-pg` client decodes from PostgreSQL, or a suite passes on PGlite while a query fails
 * on PostgreSQL: PGlite's own defaults return an int8 as a number, a date as a Date, and a time as
 * text. Each case names a SQL expression and the JavaScript value the native codec table holds for
 * the type it returns. The expected value is the native codec's own decode of an encoded sample,
 * read at test time, so the case follows `PgTypes.ts` and does not restate it.
 */
interface NativeCase {
  readonly name: string;
  readonly sql: string;
  /** The OID that PostgreSQL reports for the expression. */
  readonly oid: number;
  /** A value that the native codec encodes for that OID. */
  readonly sample: unknown;
}

const nativeCases: ReadonlyArray<NativeCase> = [
  { name: "int8", sql: "1::bigint", oid: PgTypes.OID.int8, sample: 1n },
  {
    name: "int8 above 2^31",
    sql: "2147483648::bigint",
    oid: PgTypes.OID.int8,
    sample: 2147483648n,
  },
  {
    name: "int8 2^53 + 1 stays exact",
    sql: "9007199254740993::bigint",
    oid: PgTypes.OID.int8,
    sample: 9007199254740993n,
  },
  {
    name: "int8 beyond 2^53",
    sql: "9223372036854775807::bigint",
    oid: PgTypes.OID.int8,
    sample: 9223372036854775807n,
  },
  {
    name: "count(*)",
    sql: "(SELECT count(*) FROM (VALUES (1), (2)) AS counted(n))",
    oid: PgTypes.OID.int8,
    sample: 2n,
  },
  {
    name: "int8 identity value",
    sql: "(SELECT school_id FROM (VALUES (7::bigint)) AS ids(school_id))",
    oid: PgTypes.OID.int8,
    sample: 7n,
  },
  { name: "int8[]", sql: "ARRAY[1, 2]::bigint[]", oid: PgTypes.OID.int8Array, sample: [1n, 2n] },
  { name: "int4", sql: "1::integer", oid: PgTypes.OID.int4, sample: 1 },
  { name: "int2", sql: "1::smallint", oid: PgTypes.OID.int2, sample: 1 },
  { name: "float8", sql: "1.5::float8", oid: PgTypes.OID.float8, sample: 1.5 },
  { name: "numeric", sql: "12.50::numeric", oid: PgTypes.OID.numeric, sample: "12.50" },
  { name: "date", sql: "DATE '2031-03-30'", oid: PgTypes.OID.date, sample: "2031-03-30" },
  {
    name: "date[]",
    sql: "ARRAY[DATE '2031-03-30']",
    oid: PgTypes.OID.dateArray,
    sample: ["2031-03-30"],
  },
  { name: "time", sql: "TIME '01:02:03'", oid: PgTypes.OID.time, sample: 3_723_000_000n },
  {
    name: "time with microseconds",
    sql: "TIME '01:02:03.456789'",
    oid: PgTypes.OID.time,
    sample: 3_723_456_789n,
  },
  { name: "time midnight", sql: "TIME '00:00:00'", oid: PgTypes.OID.time, sample: 0n },
  {
    name: "time[]",
    sql: "ARRAY[TIME '01:02:03']",
    oid: PgTypes.OID.timeArray,
    sample: [3_723_000_000n],
  },
  {
    name: "timestamptz",
    sql: "TIMESTAMPTZ '2031-03-30 01:02:03.456789+00'",
    oid: PgTypes.OID.timestamptz,
    sample: DateTime.toDateUtc(DateTime.makeUnsafe("2031-03-30T01:02:03.456Z")),
  },
  { name: "bool", sql: "true", oid: PgTypes.OID.bool, sample: true },
  { name: "text", sql: "'ø;😀'::text", oid: PgTypes.OID.text, sample: "ø;😀" },
  {
    name: "jsonb",
    sql: `'{"a": [1, null], "b": "c"}'::jsonb`,
    oid: PgTypes.OID.jsonb,
    sample: { a: [1, null], b: "c" },
  },
  {
    name: "bytea",
    sql: "decode('0001ff', 'hex')",
    oid: PgTypes.OID.bytea,
    sample: new Uint8Array([0, 1, 255]),
  },
];

/** What the native codec decodes for `sample` of the case's type. */
const nativeValue = Effect.fnUntraced(function* (value: NativeCase) {
  const bytes = yield* Effect.fromResult(PgTypes.encode(value.sample, value.oid));

  return yield* Effect.fromResult(PgTypes.decode(bytes, value.oid, 1));
});

/** What the test database returns for the case's expression. */
const pgliteValue = Effect.fnUntraced(function* (value: NativeCase) {
  const database = yield* Database;
  const rows = yield* database.unsafe<{ readonly value: unknown }>(`SELECT ${value.sql} AS value`);

  return rows[0]?.value;
});

layer(DatabaseTestLive(), { excludeTestServices: true, timeout: "60 seconds" })(
  "DatabaseTest returns the native client's value types",
  (it) => {
    it.effect.each(nativeCases)("$name", (value) =>
      Effect.gen(function* () {
        expect(yield* pgliteValue(value)).toEqual(yield* nativeValue(value));
      }),
    );

    it.effect("the native int8, date, and time values are the types that the parsers mirror", () =>
      Effect.gen(function* () {
        expect(yield* nativeValue(nativeCases[0]!)).toBeTypeOf("bigint");
        expect(yield* nativeValue(nativeCases.find(({ name }) => name === "date")!)).toBeTypeOf(
          "string",
        );

        expect(yield* nativeValue(nativeCases.find(({ name }) => name === "time")!)).toBeTypeOf(
          "bigint",
        );
      }),
    );
  },
);

/**
 * Negative control: with PGlite's own defaults restored for int8, date, and time, the cases that
 * those types name differ from the native values. A parity check that cannot fail proves nothing.
 */
const pgliteDefaults = {
  [types.INT8]: (text: string) => {
    const wide = BigInt(text);

    return wide <= BigInt(Number.MAX_SAFE_INTEGER) && wide >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(wide)
      : wide;
  },
  [types.DATE]: (text: string) => DateTime.toDateUtc(DateTime.makeUnsafe(text)),
  [types.TIME]: (text: string) => text,
};

layer(DatabaseTestLive({ parsers: pgliteDefaults }), {
  excludeTestServices: true,
  timeout: "60 seconds",
})("DatabaseTest with PGlite's default parsers", (it) => {
  it.effect.each(
    nativeCases.filter(({ name }) =>
      ["int8", "int8 above 2^31", "count(*)", "date", "time"].includes(name),
    ),
  )("$name differs from the native value", (value) =>
    Effect.gen(function* () {
      expect(yield* pgliteValue(value)).not.toEqual(yield* nativeValue(value));
    }),
  );
});
