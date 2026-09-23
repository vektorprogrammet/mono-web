import * as PgClient from "@effect/sql-pg/PgClient";
import { Context, Duration, Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";

/** The one native PostgreSQL pool shared by Database and Better Auth. */
export class DatabasePgPool extends Context.Service<DatabasePgPool, Pool>()(
  "@vektorprogrammet/database/DatabasePgPool",
) {}

const makeSharedPgPool = (config: Parameters<typeof PgClient.layer>[0]) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const pool = new Pool({
        connectionString: config.url === undefined ? undefined : Redacted.value(config.url),
        user: config.username,
        host: config.host,
        database: config.database,
        password: config.password === undefined ? undefined : Redacted.value(config.password),
        ssl: config.ssl,
        port: config.port,
        ...(config.stream === undefined ? {} : { stream: config.stream }),
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
      });
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
