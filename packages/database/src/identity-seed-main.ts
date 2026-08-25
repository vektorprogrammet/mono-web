import assert from "node:assert/strict";
import { Database } from "@vektorprogrammet/domain/database";
import { createLocalAccountIssuer } from "better-auth";
import { Effect, Redacted } from "effect";
import { Pool } from "pg";
import { makeAuthEngine, type AuthEngineConfig } from "./auth-engine.js";
import { DatabaseLive } from "./layers.js";
import { runDatabaseEffect } from "../runtime/node.js";

/**
 * Native identity seed entrypoint (spec 0054).
 *
 * Provisions login-capable persons against a DISPOSABLE PostgreSQL cluster:
 * inserts public.person_profiles rows, then creates better-auth users with
 * CALLER-SUPPLIED ids (auth.user.id IS PersonId - the FK requires the
 * person_profiles row to exist first). Idempotent: person inserts use
 * ON CONFLICT DO NOTHING; an auth.user row matching id or email skips the
 * person entirely. Schema migrations run first through the same DatabaseLive
 * layer every capability uses.
 *
 * Usage:
 *   IDENTITY_SEED_PG_URL=postgres://postgres@127.0.0.1:45121/postgres \
 *   IDENTITY_SEED_PERSONS='[{"personId":"...","firstName":"...","lastName":"...","email":"...","password":"..."}]' \
 *   bun run identity:seed
 */

interface SeedPerson {
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly password: string;
}

const defaultSeedUrl = "postgres://postgres@127.0.0.1:45121/postgres";

const assertLoopbackDatabaseUrl = (postgresUrl: string): void => {
  const parsed = new URL(postgresUrl);
  assert.ok(
    parsed.protocol === "postgres:" || parsed.protocol === "postgresql:",
    "IDENTITY_SEED_PG_URL must use PostgreSQL",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname),
    "identity seed is restricted to loopback PostgreSQL",
  );
};

const parsePersons = (raw: string | undefined): ReadonlyArray<SeedPerson> => {
  assert.ok(raw !== undefined && raw.length > 0, "IDENTITY_SEED_PERSONS is required");
  const decoded: unknown = JSON.parse(raw);
  assert.ok(Array.isArray(decoded), "IDENTITY_SEED_PERSONS must be a JSON array");
  return decoded.map((entry) => {
    const person = entry as Record<string, unknown>;
    const read = (field: string): string => {
      const value: unknown = person[field];
      assert.equal(typeof value, "string", `seed person.${field} must be a string`);
      const stringValue = value as string;
      assert.ok(stringValue.length > 0, `seed person.${field} must not be empty`);
      return stringValue;
    };
    const password = read("password");
    assert.ok(password.length >= 12, "seed person.password must satisfy minPasswordLength (12)");
    return {
      personId: read("personId"),
      firstName: read("firstName"),
      lastName: read("lastName"),
      email: read("email"),
      password,
    };
  });
};

const applyMigrations = (postgresUrl: string) =>
  runDatabaseEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.health;
        return database.schemaRevision;
      }).pipe(
        Effect.provide(
          DatabaseLive({
            url: Redacted.make(postgresUrl),
            applicationName: "identity-seed-migration",
            maxConnections: 1,
          }),
        ),
      ),
    ),
  );

const seedPerson = async (
  engine: ReturnType<typeof makeAuthEngine>,
  observer: Pool,
  person: SeedPerson,
): Promise<{ readonly personId: string; readonly action: "created" | "skipped" }> => {
  await observer.query(
    `INSERT INTO public.person_profiles (person_id, first_name, last_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (person_id) DO NOTHING`,
    [person.personId, person.firstName, person.lastName],
  );

  const existing = await observer.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM auth."user" WHERE id = $1 OR email = $2`,
    [person.personId, person.email],
  );
  if (existing.rows[0]?.count !== "0") {
    return { personId: person.personId, action: "skipped" };
  }

  const context = await engine.$context;
  await context.internalAdapter.createUser(
    {
      id: person.personId,
      name: `${person.firstName} ${person.lastName}`,
      email: person.email,
      emailVerified: true,
    },
    { method: "email-password" },
  );
  await context.internalAdapter.linkAccount({
    accountId: person.personId,
    providerId: "credential",
    issuer: createLocalAccountIssuer("credential"),
    userId: person.personId,
    password: await context.password.hash(person.password),
  });
  return { personId: person.personId, action: "created" };
};

const postgresUrl = process.env.IDENTITY_SEED_PG_URL ?? defaultSeedUrl;
const persons = parsePersons(process.env.IDENTITY_SEED_PERSONS);
assertLoopbackDatabaseUrl(postgresUrl);

const schemaRevision = await applyMigrations(postgresUrl);

const config: AuthEngineConfig = {
  postgresUrl,
  secret: process.env.BETTER_AUTH_SECRET ?? "identity-seed-disposable-secret-0123456789abcdef",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:5174",
};
const engine = makeAuthEngine(config);
const observer = new Pool({
  connectionString: postgresUrl,
  options: "-c search_path=public",
  max: 1,
  application_name: "identity-seed-observer",
});

try {
  const outcomes = [];
  for (const person of persons) {
    outcomes.push(await seedPerson(engine, observer, person));
  }
  process.stdout.write(`${JSON.stringify({ schemaRevision, seeded: persons.length, outcomes })}\n`);
} finally {
  const context = await engine.$context;
  const dbPool = (context.options as { readonly dbPool?: unknown }).dbPool;
  if (dbPool !== undefined && dbPool !== null && typeof (dbPool as Pool).end === "function") {
    await (dbPool as Pool).end();
  }
  await observer.end();
}
