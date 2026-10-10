/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { expect, layer } from "@effect/vitest";
import { startDisposablePostgres, type DisposablePostgres } from "@monoweb/postgres";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgTypes from "@effect/sql-pg/PgTypes";
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Result,
  Schedule,
  Schema,
} from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { nativePgLayer } from "./pg-pool.js";
import { NativeDatabaseStartupOptions } from "./search-path.js";
import { executePostgresMigration } from "./postgres-migration-statements.js";
import { TestPlatform } from "./test-support/platform.js";
import { postgresTestClient } from "./test-support/postgres.js";

class CodecCluster extends Context.Service<CodecCluster, DisposablePostgres>()(
  "@vektorprogrammet/database/native-postgres-codecs.test/CodecCluster",
) {}

const cluster = Layer.effect(
  CodecCluster,
  Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ listen: "socket", maxConnections: 8 })),
    (postgres) => Effect.promise(() => postgres.stop()),
  ),
);

const native = Layer.unwrap(
  Effect.map(CodecCluster, (postgres) =>
    nativePgLayer({
      url: Redacted.make(postgres.url),
      maxConnections: 2,
      applicationName: "native-codecs-law",
      prepare: false,
      startupOptions: NativeDatabaseStartupOptions,
    }),
  ),
).pipe(Layer.provideMerge(cluster), Layer.provideMerge(TestPlatform));

layer(native, { excludeTestServices: true, timeout: "120 seconds" })(
  "native PostgreSQL boundaries",
  (it) => {
    it.effect("decodes actual binary rows and binds JSON values once, not as JSON text", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const payload = { unicode: "ø;😀", empty: [], nested: { enabled: true }, absent: null };

        const rows = yield* sql`SELECT 9223372036854775807::bigint AS wide,
      DATE '2031-03-30' AS day, TIMESTAMP '2031-03-30 01:02:03.456' AS wall,
      TIMESTAMPTZ '2031-03-30 01:02:03.456+00' AS instant,
      decode('0001ff', 'hex') AS bytes, ${sql.json(payload)} AS payload`;

        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              wide: Schema.BigInt,
              day: Schema.String,
              wall: Schema.Date,
              instant: Schema.Date,
              bytes: Schema.Uint8Array,
              payload: Schema.Json,
            }),
          ),
        )(rows);

        expect(decoded[0]?.wide).toBe(9223372036854775807n);
        expect(decoded[0]?.day).toBe("2031-03-30");
        expect(decoded[0]?.wall.toISOString()).toBe("2031-03-30T01:02:03.456Z");
        expect(decoded[0]?.instant.toISOString()).toBe("2031-03-30T01:02:03.456Z");
        expect(decoded[0]?.bytes).toEqual(new Uint8Array([0, 1, 255]));
        expect(decoded[0]?.payload).toEqual(payload);
        expect(yield* sql`SELECT jsonb_typeof(${sql.json(payload)}) AS kind`).toEqual([
          { kind: "object" },
        ]);
      }),
    );

    it.effect.each([
      { value: true, kind: "boolean" },
      { value: 42, kind: "number" },
      { value: "ø;😀", kind: "string" },
      { value: ["α", null, 2], kind: "array" },
    ])("binds JSON scalar/array %# without double encoding", ({ value, kind }) =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;

        const rows =
          yield* sql`SELECT ${sql.json(value)} AS value, jsonb_typeof(${sql.json(value)}) AS kind`;

        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ value: Schema.Json, kind: Schema.String })),
        )(rows);

        expect(decoded).toEqual([{ value, kind }]);
      }),
    );

    it.effect("binds sql.json(null) as SQL NULL, and only the jsonb literal is JSON null", () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;

        expect(
          yield* sql`SELECT ${sql.json(null)} AS value, jsonb_typeof(${sql.json(null)}) AS kind`,
        ).toEqual([{ value: null, kind: null }]);
        expect(
          yield* sql`SELECT 'null'::jsonb AS value, jsonb_typeof('null'::jsonb) AS kind`,
        ).toEqual([{ value: null, kind: "null" }]);
      }),
    );

    it.effect(
      "preserves empty IN semantics and explicit empty array binds without erased codec failures",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const empty = yield* Effect.fromResult(PgTypes.array([], PgTypes.OID.text));
          expect(yield* sql`SELECT ${empty}::text[] AS items`).toEqual([{ items: [] }]);
          expect(yield* sql`SELECT 'a' AS value WHERE ${sql.in("value", [])}`).toEqual([]);
          expect(
            yield* sql`SELECT value FROM (VALUES ('a'), ('b')) AS input(value) WHERE ${sql.in("value", ["a"])}`,
          ).toEqual([{ value: "a" }]);
          const nullable = yield* Effect.fromResult(PgTypes.array(null, PgTypes.OID.text));
          expect(yield* sql`SELECT ${nullable}::text[] AS items`).toEqual([{ items: null }]);
          const nested = yield* Effect.flip(sql.unsafe("SELECT $1::text[]", [[["nested"]]]));
          expect(nested._tag).toBe("SqlError");
          const failure = yield* Effect.flip(Effect.fromResult(PgTypes.array([], -1)));
          expect(failure._tag).toBe("PgTypesCodecError");
        }),
    );

    it.effect(
      "keeps a Date parameter instant in a non-UTC session and rejects infinite dates at the schema boundary",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const instant = DateTime.toDateUtc(DateTime.makeUnsafe("2031-03-30T01:02:03.456Z"));
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET LOCAL TimeZone = 'Europe/Oslo'`;
              const rows = yield* sql`SELECT ${instant}::timestamptz AS instant`;

              const decoded = yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ instant: Schema.Date })),
              )(rows);

              expect(decoded[0]?.instant.toISOString()).toBe(instant.toISOString());
              const infinite = yield* sql`SELECT 'infinity'::timestamptz AS instant`;

              const rejected = yield* Effect.flip(
                Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ instant: Schema.Date })))(
                  infinite,
                ),
              );

              expect(rejected._tag).toBe("SchemaError");
            }),
          );
        }),
    );

    it.effect(
      "decodes affected counts from actual native raw metadata, including an empty result",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE codec_affected (id integer PRIMARY KEY, value text)`;
          yield* sql`INSERT INTO codec_affected VALUES (1, 'old'), (2, 'old')`;

          const decode = Schema.decodeUnknownEffect(
            Schema.Struct({
              command: Schema.String,
              rowCount: Schema.Int,
              rows: Schema.Array(Schema.Unknown),
            }),
          );

          const changed = yield* decode(
            yield* sql`UPDATE codec_affected SET value = 'new' WHERE id = 1`.raw,
          );

          expect(changed.rowCount).toBe(1);
          expect(changed.command).toBe("UPDATE");
          expect(changed.rows).toEqual([]);
          const missed = yield* decode(yield* sql`DELETE FROM codec_affected WHERE id = 99`.raw);
          expect(missed.rowCount).toBe(0);
          expect(missed.command).toBe("DELETE");
          expect(
            yield* sql`UPDATE codec_affected SET value = 'witness' WHERE id = 2 RETURNING id`,
          ).toEqual([{ id: 2 }]);
        }),
    );

    it.effect(
      "uses catalog UDT identities and explicit text casts for unknown binary array/domain layouts",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* executePostgresMigration(
            "CREATE TYPE codec_mood AS ENUM ('α', 'β'); CREATE DOMAIN codec_positive AS integer CHECK (VALUE > 0)",
          );

          const types = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ name: Schema.String, oid: Schema.Int, array: Schema.Int }),
            ),
          )(
            yield* sql`SELECT typname AS name, oid::integer AS oid, typarray::integer AS array FROM pg_type WHERE typname IN ('codec_mood', 'codec_positive') ORDER BY typname`,
          );

          expect(types.map((type) => type.name)).toEqual(["codec_mood", "codec_positive"]);
          expect(types.every((type) => type.oid > 0 && type.array > 0)).toBe(true);

          const rows = yield* sql`SELECT 'α'::codec_mood AS mood,
      ARRAY['α', 'β']::codec_mood[]::text[] AS moods,
      7::codec_positive::text AS positive`;

          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                mood: Schema.String,
                moods: Schema.Array(Schema.String),
                positive: Schema.String,
              }),
            ),
          )(rows);

          expect(decoded).toEqual([{ mood: "α", moods: ["α", "β"], positive: "7" }]);

          const mood = yield* Effect.fromNullishOr(
            types.find((type) => type.name === "codec_mood"),
          );

          const registry = PgTypes.makeRegistry();
          registry.register(
            mood.oid,
            {
              encode: (value: string) => PgTypes.encode(value, PgTypes.OID.text),
              decode: (bytes) =>
                PgTypes.decode(bytes, PgTypes.OID.text, 1).pipe(
                  Result.flatMap((value) => Schema.decodeUnknownResult(Schema.String)(value)),
                  Result.mapError((error) => new PgTypes.CodecError({ message: error.message })),
                ),
            },
            { arrayOid: mood.array },
          );
          const postgres = yield* CodecCluster;

          const registered = yield* postgresTestClient({
            url: Redacted.make(postgres.url),
            maxConnections: 1,
            types: registry,
            applicationName: "native-codec-registry",
            startupOptions: NativeDatabaseStartupOptions,
          });

          const array = yield* Effect.fromResult(PgTypes.array(["α", "β"], mood.oid, registry));
          const registeredRows = yield* registered`SELECT ${array}::codec_mood[] AS moods`;
          expect(
            yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ moods: Schema.Array(Schema.String) })),
            )(registeredRows),
          ).toEqual([{ moods: ["α", "β"] }]);
        }),
    );

    it.effect(
      "runs unchanged Unicode/dollar-quoted source sequentially and rolls every migration and ledger row back on failure",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const source = `/* α;😀 */ CREATE TABLE codec_migration (value text);
      CREATE FUNCTION codec_insert() RETURNS void LANGUAGE plpgsql AS $body$
      BEGIN INSERT INTO codec_migration VALUES ('ø;😀'); END $body$;
      SELECT codec_insert(); -- retained comment;
      INSERT INTO codec_migration VALUES ('終')`;

          yield* sql.withTransaction(executePostgresMigration(source));
          expect(yield* sql`SELECT value FROM codec_migration ORDER BY value COLLATE "C"`).toEqual([
            { value: "ø;😀" },
            { value: "終" },
          ]);

          const migrate = Migrator.make({})({
            table: "codec_migration_ledger",
            loader: Migrator.fromRecord({
              "1_first": executePostgresMigration(
                "CREATE TABLE codec_rollback (id integer); INSERT INTO codec_rollback VALUES (1)",
              ),
              "2_failure": executePostgresMigration(
                "INSERT INTO codec_rollback VALUES (2); SELECT 1 / 0; INSERT INTO codec_rollback VALUES (3)",
              ),
            }),
          });

          const failed = yield* Effect.exit(migrate);
          expect(Exit.isFailure(failed)).toBe(true);
          expect(yield* sql`SELECT to_regclass('codec_rollback')::text AS relation`).toEqual([
            { relation: null },
          ]);
          expect(yield* sql`SELECT count(*)::integer AS count FROM codec_migration_ledger`).toEqual(
            [{ count: 0 }],
          );
        }),
    );

    it.effect(
      "cancellation during a real statement stops later migration statements and rolls back",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const postgres = yield* CodecCluster;

          const observer = yield* postgresTestClient({
            url: Redacted.make(postgres.url),
            maxConnections: 1,
            applicationName: "native-codec-observer",
            startupOptions: NativeDatabaseStartupOptions,
          });

          const began = yield* Deferred.make<void>();

          const fiber = yield* Effect.forkScoped(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* Deferred.succeed(began, undefined);
                yield* executePostgresMigration(
                  "CREATE TABLE codec_cancelled (id integer); SELECT pg_sleep(30); INSERT INTO codec_cancelled VALUES (1)",
                );
              }),
            ),
          );

          yield* Deferred.await(began);
          yield* observer`SELECT count(*)::integer AS active FROM pg_stat_activity
      WHERE application_name = 'native-codecs-law' AND state = 'active' AND wait_event = 'PgSleep'`.pipe(
            Effect.repeat({
              while: (rows) => rows[0]?.active !== 1,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("2 seconds"),
          );
          yield* Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds"));
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(yield* observer`SELECT to_regclass('codec_cancelled')::text AS relation`).toEqual([
            { relation: null },
          ]);
        }),
      10_000,
    );
  },
);
