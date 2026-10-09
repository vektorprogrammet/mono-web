/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgProtocol from "@effect/sql-pg/PgProtocol";
import { startDisposablePostgres } from "@monoweb/postgres";
import {
  Context,
  Data,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Redacted,
} from "effect";
import { SqlClient } from "effect/sql";
import { type DatabaseMigrationDefinition, databaseMigrationDefinitions } from "../migrations.js";
import { executePostgresMigration } from "../postgres-migration-statements.js";
import { nativePgLayer, type NativePgPoolConfig } from "../pg-pool.js";
import { DatabaseLive } from "../layers.js";
import { NativeDatabaseStartupOptions } from "../search-path.js";
import { Database } from "../service.js";

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
 * Runs a callback on migrated, private PostgreSQL with native SQL.
 * The caller supplies the application name and platform services.
 * The Scope closes the native two-connection pool before the four-connection cluster.
 * SQL failures inside a transaction use the real PostgreSQL rollback protocol.
 */
export const withRealPostgres = Effect.fnUntraced(function* <A, E, R>(
  applicationName: string,
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
) {
  const cluster = yield* Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ listen: "tcp", maxConnections: 4 })),
    (disposable) => Effect.promise(() => disposable.stop()),
  );

  const services = yield* Layer.build(
    DatabaseLive({
      url: Redacted.make(cluster.url),
      maxConnections: 2,
      applicationName,
      startupOptions: NativeDatabaseStartupOptions,
    }),
  );

  return yield* use(Context.get(services, Database));
}, Effect.scoped);

/** A statement that the PostgreSQL server rejected on the PGlite socket, with its SQLSTATE and message. */
export class PgliteSocketRejectedStatement extends Data.TaggedError(
  "PgliteSocketRejectedStatement",
)<{
  readonly sqlState: string;
  readonly detail: string;
}> {
  override get message() {
    return (
      `PGlite socket server saw a rejected statement (SQLSTATE ${this.sqlState}: ${this.detail}). ` +
      "Its message-by-message protocol bridge gives the native client a second ReadyForQuery after an " +
      "ErrorResponse, which is fatal for the connection. Declare the test on withRealPostgres."
    );
  }
}

/** Uses the public native incremental protocol parser to report server ErrorResponses. */
export const makeErrorFrameScanner = (
  onRejected: (rejection: PgliteSocketRejectedStatement) => void,
) => {
  const parser = PgProtocol.makeParser();

  return (chunk: Uint8Array) =>
    parser.pushEach(chunk, (message) => {
      if (Predicate.isTagged(message, "ErrorResponse"))
        onRejected(
          new PgliteSocketRejectedStatement({
            sqlState: message.fields.code ?? "unknown",
            detail: message.fields.message ?? "unknown",
          }),
        );
    });
};

/**
 * PGlite behind a socket server that refuses to carry a rejected statement.
 *
 * PGlite 0.5.8 with pglite-socket 0.2.11 executes the pipelined protocol one frontend message at a
 * time. After an ErrorResponse the native client reads a second ReadyForQuery and ends the
 * connection with "Unexpected ReadyForQuery during parse", whether the statement ran in a
 * transaction or not, and the replacement connection meets `maxConnections: 1`. PostgreSQL 17 and
 * 18 pass the same sequence. The guard therefore watches the frames that the server sends, so that
 * a test that needs PostgreSQL's error protocol fails the same way every time: see
 * `refusingRejectedStatements`. `database` is the PGlite instance itself: in-process calls on it
 * use PGlite's own error handling and stay outside the guard.
 */
export const pgliteSocketDatabase = Effect.fnUntraced(function* () {
  const database = yield* Effect.acquireRelease(
    Effect.promise(() => PGlite.create({ extensions: { btree_gist } })),
    (database) => Effect.promise(() => database.close()),
  );

  const rejected = yield* Deferred.make<PgliteSocketRejectedStatement>();

  const watched = new Proxy(database, {
    get(target, property) {
      if (property === "execProtocolRawStream")
        return (
          message: Uint8Array,
          options: Parameters<typeof target.execProtocolRawStream>[1],
        ) => {
          const scan = makeErrorFrameScanner((rejection) => {
            Deferred.doneUnsafe(rejected, Effect.succeed(rejection));
          });

          return target.execProtocolRawStream(message, {
            ...options,
            onRawData: (chunk) => {
              scan(chunk);
              options?.onRawData(chunk);
            },
          });
        };

      // SAFETY: the trap receives the name of a property read on a PGlite and forwards it to that PGlite.
      const value = target[property as keyof PGlite];

      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });

  const server = yield* Effect.acquireRelease(
    Effect.sync(
      () => new PGLiteSocketServer({ db: watched, host: "127.0.0.1", port: 0, maxConnections: 1 }),
    ),
    (server) => Effect.promise(() => server.stop()),
  );

  return { database, server, rejected } as const;
});

/** A database behind `pgliteSocketDatabase`. */
export type PgliteSocketDatabase = Effect.Success<ReturnType<typeof pgliteSocketDatabase>>;

/**
 * Runs `use` and ends it with a `PgliteSocketRejectedStatement` defect as soon as the socket
 * server has sent an ErrorResponse, also when `use` handled the SQL failure and went on.
 * The defect is a test-authoring error: the test belongs on `withRealPostgres`.
 */
export const refusingRejectedStatements = <A, E, R>(
  socket: PgliteSocketDatabase,
  use: Effect.Effect<A, E, R>,
) =>
  Effect.raceFirst(use, Deferred.await(socket.rejected).pipe(Effect.flatMap(Effect.die))).pipe(
    Effect.tap(() =>
      Deferred.isDone(socket.rejected).pipe(
        Effect.flatMap((done) =>
          done ? Deferred.await(socket.rejected).pipe(Effect.flatMap(Effect.die)) : Effect.void,
        ),
      ),
    ),
  );

/**
 * Runs `use` on a native SqlClient through the explicitly selected migrations.
 * The native pool closes before the socket server and PGlite database. No fake
 * Database service or migration/health no-op is supplied. Each selected source
 * executes sequentially in its own transaction; `use` owns any later transaction.
 * A statement that the server rejects ends `use` with `PgliteSocketRejectedStatement`:
 * failure paths run on `withRealPostgres`.
 */
export const withPostgresTestDatabase = Effect.fnUntraced(function* <A, E, R>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>,
  migrations: ReadonlyArray<DatabaseMigrationDefinition> = databaseMigrationDefinitions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const socket = yield* pgliteSocketDatabase();

  yield* Effect.promise(() => socket.server.start());

  return yield* refusingRejectedStatements(
    socket,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      for (const migration of migrations) {
        const source = yield* fs.readFileString(yield* path.fromFileUrl(migration.url));
        yield* sql.withTransaction(executePostgresMigration(source));
      }

      return yield* use(sql);
    }).pipe(
      Effect.provide(
        nativePgLayer({
          url: Redacted.make(`postgres://postgres@${socket.server.getServerConn()}/postgres`),
          maxConnections: 1,
          minConnections: 0,
          idleTimeout: "30 seconds",
          connectionTTL: undefined,
          prepare: false,
          startupOptions: NativeDatabaseStartupOptions,
        }),
      ),
    ),
  );
}, Effect.scoped);
