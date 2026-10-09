/**
 * EX-0021: required public native SQL APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import { Context, Effect, FiberSet, Layer, Schema } from "effect";
import { Pool } from "pg";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** The supported node-postgres pool owned only by the Better Auth layer. */
export class AuthPgPool extends Context.Service<AuthPgPool, Pool>()(
  "@vektorprogrammet/database/pg-pool/AuthPgPool",
) {}

const positiveMilliseconds = Schema.Int.check(Schema.isGreaterThan(0));

/** Host-supplied limits for the supported Better Auth driver, separate from native Effect SQL. */
export const AuthPoolOptions = Schema.Struct({
  maxConnections: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(4)),
  applicationName: Schema.NonEmptyString,
  pipeline: Schema.Boolean,
  connectTimeoutMilliseconds: Schema.optionalKey(positiveMilliseconds),
  queryTimeoutMilliseconds: Schema.optionalKey(positiveMilliseconds),
  startupOptions: Schema.optionalKey(Schema.String),
});

export type AuthPoolOptions = typeof AuthPoolOptions.Type;

/** A native SQL pool limit is explicit at each host composition, never the driver default. */
export interface NativePgPoolConfig extends Omit<
  PgClient.PgPoolConfig,
  "multiplex" | "multiplexConcurrency"
> {
  readonly maxConnections: number;
}

/** The approved backend cap. Smaller host-owned pools use the same limit decoder. */
export const NativePgPoolLimit = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(8),
);

const decodeNativePgPoolLimit = Schema.decodeEffect(NativePgPoolLimit);

/**
 * Builds the native SQL layer with an explicit host-owned connection limit.
 *
 * @remarks
 * The caller owns the layer scope. The native driver owns acquisition, transaction reservation,
 * cancellation, and release. Each checkout is exclusive. The driver can queue waiting fibers,
 * so this limit bounds connections, not admitted work. Prepared statements require an explicit
 * choice for a compatible pooler. An absent connectionTTL preserves unlimited connection reuse.
 * Building the layer performs no work. Its scope closes its native pool on every exit.
 *
 * @param config Native connection configuration with the host limit.
 * @returns The native PgClient and SqlClient layer, with configuration or SQL failures.
 * @sideEffects Opens native PostgreSQL sessions only after the layer runs.
 * @example
 * ```ts
 * const sql = nativePgLayer({ url, maxConnections: 2, prepare: false });
 * ```
 * @avoid Providing a new layer for each service or enabling multiplexing on a cancellable path.
 * @construct sql-lifecycle
 */
export const nativePgLayer = (
  config: NativePgPoolConfig,
): Layer.Layer<PgClient.PgClient | SqlClient.SqlClient, Schema.SchemaError | SqlError> =>
  Layer.unwrap(
    Effect.suspend(() =>
      decodeNativePgPoolLimit(config.maxConnections).pipe(
        Effect.map((maxConnections) =>
          PgClient.layer({
            ...config,
            maxConnections,
            minConnections: config.minConnections ?? 0,
            idleTimeout: config.idleTimeout ?? "10 seconds",
            connectionTTL: config.connectionTTL,
            prepare: config.prepare ?? false,
            multiplex: false,
            multiplexConcurrency: 1,
          }),
        ),
      ),
    ),
  );

const decodeAuthPoolOptions = Schema.decodeEffect(AuthPoolOptions);

/**
 * Builds the supported Better Auth pool with its own host-supplied capacity.
 *
 * @remarks
 * This layer owns only the node-postgres pool. It never provides native SqlClient.
 * The host provides it separately from Database. Native callback fibers close before
 * the pool, and pool diagnostic fibers remain owned until the pool closes.
 * A client deadline does not prove PostgreSQL cancellation or a committed outcome.
 *
 * @param config The same PostgreSQL URL as the native Database, supplied by the host.
 * @param options The explicit auth capacity, transport policy, and startup configuration.
 * @returns The scoped AuthPgPool layer, with invalid configuration in the error channel.
 * @sideEffects Opens supported pg sessions only when the auth adapter uses the layer.
 * @example
 * ```ts
 * const authPool = AuthPoolLive(config, {
 *   maxConnections: 2,
 *   applicationName: "vektorprogrammet-worker-auth",
 *   pipeline: true,
 *   connectTimeoutMilliseconds: 2_000,
 *   queryTimeoutMilliseconds: 1_000,
 * });
 * ```
 * @avoid Providing this layer to a delivery-only event or sharing it with native Effect SQL.
 * @construct sql-lifecycle
 */
export const AuthPoolLive = (
  config: { readonly postgresUrl: string },
  options: AuthPoolOptions,
): Layer.Layer<AuthPgPool, Schema.SchemaError> =>
  Layer.effect(
    AuthPgPool,
    Effect.gen(function* () {
      const decoded = yield* decodeAuthPoolOptions(options);
      const runPoolCallback = yield* FiberSet.makeRuntime();

      const onIdleError = () => {
        runPoolCallback(Effect.logWarning("Better Auth idle PostgreSQL connection failed"));
      };

      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          const pool = new Pool({
            connectionString: config.postgresUrl,
            max: decoded.maxConnections,
            application_name: decoded.applicationName,
            pipeline: decoded.pipeline,
            connectionTimeoutMillis: decoded.connectTimeoutMilliseconds,
            query_timeout: decoded.queryTimeoutMilliseconds,
            options: decoded.startupOptions,
          });

          pool.on("error", onIdleError);

          return pool;
        }),
        (pool) =>
          Effect.promise(() => pool.end()).pipe(
            Effect.ensuring(Effect.sync(() => pool.off("error", onIdleError))),
          ),
      );
    }),
  );
