/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Context, Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { type DatabaseMigrationDefinition, databaseMigrationDefinitions } from "../migrations.js";
import { executePostgresMigration } from "../postgres-migration-statements.js";
import { nativePgLayer, type NativePgPoolConfig } from "../pg-pool.js";

/** A scoped native test client; the caller's Scope owns physical pool shutdown. */
export const postgresTestClient = Effect.fnUntraced(function* (config: NativePgPoolConfig) {
  const context = yield* Layer.build(
    nativePgLayer({
      minConnections: 0,
      idleTimeout: "30 seconds",
      connectionTTL: undefined,
      prepare: false,
      ...config,
    }),
  );

  return Context.get(context, PgClient.PgClient);
});

/**
 * Runs `use` on a native SqlClient through the explicitly selected migrations.
 * The native pool closes before the socket server and PGlite database. No fake
 * Database service or migration/health no-op is supplied. Each selected source
 * executes sequentially in its own transaction; `use` owns any later transaction.
 */
export const withPostgresTestDatabase = Effect.fnUntraced(function* <A, E, R>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
  migrations: ReadonlyArray<DatabaseMigrationDefinition> = databaseMigrationDefinitions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const database = yield* Effect.acquireRelease(
    Effect.promise(() => PGlite.create({ extensions: { btree_gist } })),
    (database) => Effect.promise(() => database.close()),
  );

  const server = yield* Effect.acquireRelease(
    Effect.sync(
      () => new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 1 }),
    ),
    (server) => Effect.promise(() => server.stop()),
  );

  yield* Effect.promise(() => server.start());

  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    for (const migration of migrations) {
      const source = yield* fs.readFileString(yield* path.fromFileUrl(migration.url));
      yield* sql.withTransaction(executePostgresMigration(source));
    }

    return yield* use(sql);
  }).pipe(
    Effect.provide(
      nativePgLayer({
        url: Redacted.make(`postgres://postgres@${server.getServerConn()}/postgres`),
        maxConnections: 1,
        minConnections: 0,
        idleTimeout: "30 seconds",
        connectionTTL: undefined,
        prepare: false,
      }),
    ),
  );
}, Effect.scoped);
