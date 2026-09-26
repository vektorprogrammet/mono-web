import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Effect, FileSystem, Path } from "effect";
import { Pool } from "pg";
import { type DatabaseMigrationDefinition, databaseMigrationDefinitions } from "../migrations.js";

/**
 * Runs `use` on a PGlite database through `migrations`, by default every registered migration.
 * The pool, the socket server, and the database close in that order when `use` ends.
 */
export const withPostgresTestDatabase = <A, E, R>(
  use: (pool: Pool) => Effect.Effect<A, E, R>,
  migrations: ReadonlyArray<DatabaseMigrationDefinition> = databaseMigrationDefinitions,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const database = yield* Effect.acquireRelease(
        Effect.promise(() => PGlite.create({ extensions: { btree_gist } })),
        (database) => Effect.promise(() => database.close()),
      );

      for (const migration of migrations) {
        const source = yield* fs.readFileString(yield* path.fromFileUrl(migration.url));
        yield* Effect.promise(() => database.exec(source));
      }

      const server = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new PGLiteSocketServer({
              db: database,
              host: "127.0.0.1",
              port: 0,
              maxConnections: 1,
            }),
        ),
        (server) => Effect.promise(() => server.stop()),
      );

      yield* Effect.promise(() => server.start());

      const pool = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Pool({
              connectionString: `postgres://postgres@${server.getServerConn()}/postgres`,
              max: 1,
            }),
        ),
        (pool) => Effect.promise(() => pool.end()),
      );

      return yield* use(pool);
    }),
  );
