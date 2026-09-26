import * as PgClient from "@effect/sql-pg/PgClient";
import { Context, Data, Duration, Effect, Layer, Redacted } from "effect";
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

/** The one native PostgreSQL pool shared by Database and Better Auth. */
export class DatabasePgPool extends Context.Service<DatabasePgPool, Pool>()(
  "@vektorprogrammet/database/DatabasePgPool",
) {}

/** A node-postgres connection or statement failure, carrying the driver's message. */
export class PgQueryError extends Data.TaggedError("PgQueryError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const pgFailure = (cause: unknown): PgQueryError =>
  new PgQueryError({
    message: cause instanceof Error ? cause.message : "PostgreSQL statement failed",
    cause,
  });

/** Runs one parameterized statement on a node-postgres pool or on a client it lent. */
export const pgQuery = <R extends QueryResultRow = QueryResultRow>(
  database: Pool | PoolClient,
  text: string,
  values: ReadonlyArray<unknown> = [],
): Effect.Effect<QueryResult<R>, PgQueryError> =>
  Effect.tryPromise({ try: () => database.query<R>(text, [...values]), catch: pgFailure });

/**
 * Runs `use` in one transaction on a client lent by `pool`: BEGIN, then COMMIT when `use`
 * succeeds, or ROLLBACK when it fails or is interrupted. The client returns to the pool either way.
 */
export const pgTransaction = <A, E, R>(
  pool: Pool,
  use: (client: PoolClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PgQueryError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => pool.connect(), catch: pgFailure }),
    (client) =>
      pgQuery(client, "BEGIN").pipe(
        Effect.andThen(use(client)),
        Effect.tap(() => pgQuery(client, "COMMIT")),
        Effect.onError(() => Effect.ignore(pgQuery(client, "ROLLBACK"))),
      ),
    (client) => Effect.sync(() => client.release()),
  );

const makeSharedPgPool = (config: Parameters<typeof PgClient.layer>[0]) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const options: PoolConfig = {
        connectionString: config.url === undefined ? undefined : Redacted.value(config.url),
        user: config.username,
        host: config.host,
        database: config.database,
        password: config.password === undefined ? undefined : Redacted.value(config.password),
        ssl: config.ssl,
        port: config.port,
        connectionTimeoutMillis:
          config.connectTimeout === undefined
            ? undefined
            : Duration.toMillis(Duration.fromInputUnsafe(config.connectTimeout)),
        idleTimeoutMillis:
          config.idleTimeout === undefined
            ? undefined
            : Duration.toMillis(Duration.fromInputUnsafe(config.idleTimeout)),
        max: config.maxConnections,
        min: config.minConnections,
        maxLifetimeSeconds:
          config.connectionTTL === undefined
            ? undefined
            : Duration.toSeconds(Duration.fromInputUnsafe(config.connectionTTL)),
        application_name: config.applicationName ?? "@effect/sql-pg",
        options: "-c search_path=auth,public",
        types: config.types,
      };

      if (config.stream !== undefined) options.stream = config.stream;

      const pool = new Pool(options);

      pool.on("error", () => {});

      return pool;
    }),
    (pool) =>
      Effect.promise(() => pool.end()).pipe(
        Effect.timeoutOption(Duration.seconds(1)),
        Effect.ignore,
      ),
  );

export const sharedPgLayer = (config: Parameters<typeof PgClient.layer>[0]) => {
  const poolLayer = Layer.effect(DatabasePgPool, makeSharedPgPool(config));

  const clientLayer = PgClient.layerFrom(
    Effect.gen(function* () {
      const pool = yield* DatabasePgPool;

      return yield* PgClient.fromPool({ ...config, acquire: Effect.succeed(pool) });
    }),
  );

  return clientLayer.pipe(Layer.provideMerge(poolLayer));
};
