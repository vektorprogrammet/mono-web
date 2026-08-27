import { makeAuthEngine } from "./auth-engine.js";

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
export const auth = makeAuthEngine({
  postgresUrl: process.env.AUTH_GENERATE_PG_URL ?? "postgres://postgres@127.0.0.1:45121/postgres",
  secret: process.env.BETTER_AUTH_SECRET ?? "generator-only-not-a-runtime-secret",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
});
