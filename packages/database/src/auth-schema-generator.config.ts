/** EX-0021: native SQL declarations retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import type { AuthEngineConfig } from "./auth-engine.js";
import { Config, ConfigProvider, Effect, ManagedRuntime, Layer, Redacted } from "effect";
import { NativeAuthEngine, AuthSchemaGeneratorLive } from "./auth-engine.js";
import { AuthPoolLive, nativePgLayer } from "./pg-pool.js";
import { BetterAuthStartupOptions, NativeDatabaseStartupOptions } from "./search-path.js";
import { SecretEqualityLive } from "./web-crypto.js";
import * as BunServices from "@effect/platform-bun/BunServices";
import process from "node:process";

// A set but empty variable stays empty: only an unset one takes the default.
const generatorEnvironment = Effect.runSync(
  Config.all({
    postgresUrl: Config.String("AUTH_GENERATE_PG_URL").pipe(
      Config.withDefault("postgres://postgres@127.0.0.1:45121/postgres"),
    ),
    secret: Config.String("BETTER_AUTH_SECRET").pipe(
      Config.withDefault("generator-only-not-a-runtime-secret"),
    ),
  }).parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
);

/**
 * Generator-only config for migration 0015 provenance (spec 0054).
 *
 * Regenerate the canonical auth DDL with the version-pinned CLI:
 *   bunx --bun auth@<pinned> generate \
 *     --config packages/database/src/auth-schema-generator.config.ts \
 *     --output <file> --yes
 *
 * Point AUTH_GENERATE_PG_URL at a disposable PostgreSQL cluster. This generator
 * owns native SQL and supported Better Auth pools but runs no application migration.
 * It exposes the same engine options without enabling runtime delivery callbacks.
 */
const config: AuthEngineConfig = {
  ...generatorEnvironment,
  oauth: {
    canonicalOrigin: "http://127.0.0.1:4173",
    dashboardOrigin: "http://127.0.0.1:4173",
    nativeApiResource: "urn:vektorprogrammet:native-api",
  },
  trustedOrigins: ["http://127.0.0.1:4173"],
  secureCookies: false,
};

const runtime = ManagedRuntime.make(
  AuthSchemaGeneratorLive(config).pipe(
    Layer.provide(
      Layer.mergeAll(
        AuthPoolLive(config, {
          maxConnections: 1,
          applicationName: "auth-schema-generator-auth",
          pipeline: false,
          startupOptions: BetterAuthStartupOptions,
        }),
        nativePgLayer({
          url: Redacted.make(config.postgresUrl),
          maxConnections: 1,
          startupOptions: NativeDatabaseStartupOptions,
          applicationName: "auth-schema-generator-sql",
        }),
        SecretEqualityLive(globalThis.crypto.subtle),
      ),
    ),
    Layer.provide(BunServices.layer),
  ),
);

process.once("beforeExit", () => {
  void runtime.dispose();
});

export const auth = await runtime.runPromise(NativeAuthEngine);
