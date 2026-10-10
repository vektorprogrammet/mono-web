/**
 * EX-0021: required public native SQL APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { assert, layer } from "@effect/vitest";
import { startDisposablePostgres } from "@monoweb/postgres";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { BetterAuthStartupOptions, NativeDatabaseStartupOptions } from "./search-path.js";
import { DatabaseLive } from "./layers.js";
import { AuthPgPool, AuthPoolLive, nativePgLayer, type NativePgPoolConfig } from "./pg-pool.js";
import { DatabaseRuntimeLive } from "./runtime-layer.js";
import { Database } from "./service.js";
import { TestPlatform } from "./test-support/platform.js";

const departmentId = "search-path-law-department";

const personId = "search-path-law-person";

/** Every table-like relation name that both `auth` and `public` declare, with its sorted schemas and kinds. */
const collisionInventory = `
  SELECT relation.relname AS relation_name,
         array_agg(namespace.nspname::text ORDER BY namespace.nspname) AS schemas,
         array_agg(relation.relkind::text ORDER BY namespace.nspname) AS relation_kinds
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname IN ('auth', 'public')
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  GROUP BY relation.relname
  HAVING count(DISTINCT namespace.nspname) = 2
  ORDER BY relation.relname COLLATE "C"
`;

const CollisionRows = Schema.Array(
  Schema.Struct({
    relation_name: Schema.String,
    schemas: Schema.Array(Schema.String),
    relation_kinds: Schema.Array(Schema.String),
  }),
);

const NameRows = Schema.Array(Schema.Struct({ name: Schema.String }));

const SearchPathRows = Schema.Array(Schema.Struct({ search_path: Schema.String }));

const TableSourceRows = Schema.Array(
  Schema.Struct({ source: Schema.String, search_path: Schema.String }),
);

const decodeCollisions = Schema.decodeUnknownEffect(CollisionRows);

const decodeNames = Schema.decodeUnknownEffect(NameRows);

const decodeSearchPaths = Schema.decodeUnknownEffect(SearchPathRows);

const decodeTableSources = Schema.decodeUnknownEffect(TableSourceRows);

const encodeCollisions = Schema.encodeEffect(Schema.fromJsonString(CollisionRows));

const nativeConfig = (
  url: string,
  applicationName: string,
  startupOptions: string,
): NativePgPoolConfig => ({
  url: Redacted.make(url),
  maxConnections: 1,
  applicationName,
  startupOptions,
});

/** The production bare read of the shadowed business relation, schema-decoded. */
const bareDepartmentName = (sql: SqlClient.SqlClient) =>
  sql`SELECT name FROM organization_departments WHERE department_id = ${departmentId}`.pipe(
    Effect.flatMap(decodeNames),
    Effect.map((rows) => rows.map(({ name }) => name)),
  );

const declaredSearchPath = (sql: SqlClient.SqlClient) =>
  sql`SELECT current_setting('search_path') AS search_path`.pipe(
    Effect.flatMap(decodeSearchPaths),
    Effect.map((rows) => rows.map(({ search_path }) => search_path.replaceAll(" ", ""))),
  );

layer(TestPlatform, { excludeTestServices: true, timeout: "90 seconds" })(
  "schema search-path shadowing",
  (it) => {
    it.effect(
      "resolves bare production names through the pool-owned search_path, not a shadow in another schema",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const cluster = yield* Effect.acquireRelease(
              Effect.promise(() => startDisposablePostgres({ listen: "tcp", maxConnections: 12 })),
              (started) => Effect.promise(() => started.stop()),
            );

            // Building DatabaseLive migrates the cluster through the production native policy.
            const database = Context.get(
              yield* Layer.build(
                DatabaseLive(
                  nativeConfig(cluster.url, "search-path-law-native", NativeDatabaseStartupOptions),
                ),
              ),
              Database,
            );

            const runtime = Context.get(
              yield* Layer.build(
                DatabaseRuntimeLive(
                  nativeConfig(
                    cluster.url,
                    "search-path-law-runtime",
                    NativeDatabaseStartupOptions,
                  ),
                ),
              ),
              Database,
            );

            const control = Context.get(
              yield* Layer.build(
                nativePgLayer(
                  nativeConfig(
                    cluster.url,
                    "search-path-law-control",
                    "-c search_path=auth,public",
                  ),
                ),
              ),
              SqlClient.SqlClient,
            );

            const authPool = Context.get(
              yield* Layer.build(
                AuthPoolLive(
                  { postgresUrl: cluster.url },
                  {
                    maxConnections: 1,
                    applicationName: "search-path-law-auth",
                    pipeline: false,
                    startupOptions: BetterAuthStartupOptions,
                  },
                ),
              ),
              AuthPgPool,
            );

            const before = yield* database
              .unsafe(collisionInventory)
              .pipe(Effect.flatMap(decodeCollisions));

            yield* Effect.logInfo(
              `SEARCH_PATH_COLLISIONS before-shadows ${yield* encodeCollisions(before)}`,
            );

            assert.deepStrictEqual(
              before.map(({ relation_name }) => relation_name),
              [],
              "a migration made a relation name exist in both auth and public; qualify its production SQL and update this list",
            );

            yield* database`INSERT INTO public.organization_departments (department_id, name, short_name, email, city)
              VALUES (${departmentId}, 'public-business', 'PB', 'public@example.invalid', 'Oslo')`;
            yield* database`CREATE TABLE auth.organization_departments (LIKE public.organization_departments INCLUDING ALL)`;
            yield* database`INSERT INTO auth.organization_departments (department_id, name, short_name, email, city)
              VALUES (${departmentId}, 'auth-shadow', 'AS', 'auth@example.invalid', 'Bergen')`;

            for (const [label, sql] of [
              ["native", database],
              ["runtime", runtime],
            ] as const) {
              assert.deepStrictEqual(
                yield* bareDepartmentName(sql),
                ["public-business"],
                `${label} bare read`,
              );
              assert.deepStrictEqual(
                yield* declaredSearchPath(sql),
                ["public"],
                `${label} search_path`,
              );
            }

            yield* database`UPDATE auth.organization_departments SET name = 'auth-shadow-mutated'
              WHERE department_id = ${departmentId}`;

            for (const [label, sql] of [
              ["native", database],
              ["runtime", runtime],
            ] as const) {
              assert.deepStrictEqual(
                yield* bareDepartmentName(sql),
                ["public-business"],
                `${label} bare read ignores the mutated shadow`,
              );
            }

            const qualifiedShadow = yield* database`SELECT name FROM auth.organization_departments
              WHERE department_id = ${departmentId}`.pipe(Effect.flatMap(decodeNames));

            assert.deepStrictEqual(
              qualifiedShadow.map(({ name }) => name),
              ["auth-shadow-mutated"],
              "the qualified read observes the mutation, so the shadow is not vacuous",
            );

            assert.deepStrictEqual(yield* declaredSearchPath(control), ["auth,public"]);
            assert.deepStrictEqual(
              yield* bareDepartmentName(control),
              ["auth-shadow-mutated"],
              "negative control: a loosened search_path resolves to the shadow",
            );

            yield* database`INSERT INTO public.person_profiles (person_id, first_name, last_name)
              VALUES (${personId}, 'Search', 'Path')`;
            yield* database`INSERT INTO auth."user" (id, name, email, "emailVerified")
              VALUES (${personId}, 'Search Path', 'search-path@example.invalid', true)`;
            yield* database`CREATE TABLE public."user" (id text PRIMARY KEY, marker text NOT NULL)`;
            yield* database`INSERT INTO public."user" (id, marker) VALUES ('public-shadow-user', 'shadow')`;

            // regclass text omits the schema when it is on the search_path, so join the catalog.
            const authRead = yield* Effect.promise(() =>
              authPool.query(
                `SELECT (SELECT namespace.nspname FROM pg_catalog.pg_class relation
                         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
                         WHERE relation.oid = "user".tableoid) AS source,
                        current_setting('search_path') AS search_path
                 FROM "user"`,
              ),
            );

            assert.deepStrictEqual(
              yield* decodeTableSources(authRead.rows),
              [{ source: "auth", search_path: "auth" }],
              'an unqualified supported-pg read resolves auth."user", not the public shadow',
            );

            const after = yield* database
              .unsafe(collisionInventory)
              .pipe(Effect.flatMap(decodeCollisions));

            yield* Effect.logInfo(
              `SEARCH_PATH_COLLISIONS after-shadows ${yield* encodeCollisions(after)}`,
            );

            const known = new Set(before.map(({ relation_name }) => relation_name));

            assert.deepStrictEqual(
              after.map(({ relation_name }) => relation_name).filter((name) => !known.has(name)),
              ["organization_departments", "user"],
              "the planted shadows are the only new collisions",
            );
          }),
        ),
      60_000,
    );
  },
);
