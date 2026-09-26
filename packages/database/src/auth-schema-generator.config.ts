import type { AuthEngineConfig } from "./auth-engine.js";
import { Config, ConfigProvider, Effect, ManagedRuntime, Layer } from "effect";
import { NativeAuthEngine, NativeAuthEngineLive, AuthPoolLive } from "./auth-engine.js";

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
 *   npx --yes auth@<pinned> generate \
 *     --config packages/database/src/auth-schema-generator.config.ts \
 *     --output <file> --yes
 *
 * Point AUTH_GENERATE_PG_URL at a disposable PostgreSQL cluster - generation
 * must never target the authoritative database. Runtime wiring stays in
 * auth-engine.ts; this file only re-exports the engine for the CLI.
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
  NativeAuthEngineLive(config).pipe(Layer.provide(AuthPoolLive(config))),
);

process.once("beforeExit", () => {
  void runtime.dispose();
});

export const auth = await runtime.runPromise(NativeAuthEngine);
