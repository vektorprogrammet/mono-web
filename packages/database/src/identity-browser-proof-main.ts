import assert from "node:assert/strict";
import { Effect, Redacted } from "effect";
import { Pool } from "pg";
import { Database } from "@vektorprogrammet/domain/database";
import { DatabaseLive } from "./layers.js";

const personId = "journey-0065-admin";
const identityMigrationId = 15;
const authTables = ["account", "session", "user", "verification"] as const;

const loopbackDatabase = (value: string): void => {
  const url = new URL(value);
  assert.ok(
    ["postgres:", "postgresql:"].includes(url.protocol),
    "DATABASE_URL must use PostgreSQL",
  );
  assert.ok(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname),
    "proof requires loopback PostgreSQL",
  );
};

const runMigrations = (url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Database;
      yield* database.health;
      return database.schemaRevision;
    }).pipe(
      Effect.provide(
        DatabaseLive({
          url: Redacted.make(url),
          applicationName: "identity-browser-0065-proof-migration",
          maxConnections: 1,
        }),
      ),
    ),
  );

const run = async () => {
  const url = process.env.IDENTITY_EVIDENCE_PG_URL ?? process.env.DATABASE_URL;
  assert.ok(url !== undefined, "IDENTITY_EVIDENCE_PG_URL is required");
  loopbackDatabase(url);
  // oxlint-disable-next-line effect/no-premature-execution -- runtime proof composes the migration observer
  const schemaRevision = await Effect.runPromise(runMigrations(url));
  const observer = new Pool({
    connectionString: url,
    options: "-c search_path=public",
    max: 1,
    application_name: "identity-browser-0065-proof-observer",
  });
  try {
    const migration = await observer.query(
      `SELECT migration_id AS "migrationId", name
       FROM public.vektorprogrammet_schema_migrations
       WHERE migration_id = $1`,
      [identityMigrationId],
    );
    assert.deepEqual(migration.rows, [{ migrationId: 15, name: "native-identity-better-auth" }]);
    const tables = await observer.query<{ readonly tableName: string }>(
      `SELECT table_name AS "tableName" FROM information_schema.tables
       WHERE table_schema = 'auth' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [[...authTables]],
    );
    assert.deepEqual(
      tables.rows.map((row) => row.tableName),
      [...authTables],
    );
    const publicTables = await observer.query(
      `SELECT table_name AS "tableName" FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...authTables]],
    );
    assert.deepEqual(publicTables.rows, []);
    const identityForeignKey = await observer.query(
      `SELECT 1 FROM pg_constraint c
       JOIN pg_class source ON source.oid = c.conrelid
       JOIN pg_namespace source_schema ON source_schema.oid = source.relnamespace
       JOIN pg_class target ON target.oid = c.confrelid
       JOIN pg_namespace target_schema ON target_schema.oid = target.relnamespace
       WHERE c.contype = 'f' AND source_schema.nspname = 'auth' AND source.relname = 'user'
         AND target_schema.nspname = 'public' AND target.relname = 'person_profiles'
         AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = source.oid AND attname = 'id')]::smallint[]`,
    );
    assert.equal(identityForeignKey.rowCount, 1);
    const facts = await observer.query(
      `SELECT
         (SELECT count(*) FROM public.person_profiles WHERE person_id = $1) AS profiles,
         (SELECT count(*) FROM public.person_contact_profiles WHERE person_id = $1) AS contacts,
         (SELECT count(*) FROM public.organization_global_administrator_grants
           WHERE person_id = $1 AND start_at <= now() AND (end_at IS NULL OR now() < end_at)) AS grants,
         (SELECT count(*) FROM auth."user" WHERE id = $1) AS users,
         (SELECT count(*) FROM auth.account WHERE "userId" = $1 AND "providerId" = 'credential') AS accounts,
         (SELECT count(*) FROM auth.session WHERE "userId" = $1) AS "sessionsTotal",
         (SELECT count(*) FROM auth.session WHERE "userId" = $1 AND "expiresAt" > now()) AS "sessionsLive"`,
      [personId],
    );
    const row = facts.rows[0];
    const counts = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    );
    assert.deepEqual(counts, {
      profiles: 1,
      contacts: 1,
      grants: 1,
      users: 1,
      accounts: 1,
      sessionsTotal: 0,
      sessionsLive: 0,
    });
    process.stdout.write(
      `${JSON.stringify({
        specId: "0065",
        database: "PostgreSQL",
        migration: { revision: 15, name: "native-identity-better-auth" },
        schemaRevision,
        authTables: [...authTables],
        publicAuthTables: 0,
        personIdForeignKey: true,
        seedRows: {
          profiles: counts.profiles,
          contacts: counts.contacts,
          globalAdministratorGrants: counts.grants,
          users: counts.users,
          credentialAccounts: counts.accounts,
        },
        sessions: { total: counts.sessionsTotal, live: counts.sessionsLive },
        observer: "distinct-loopback-postgresql-connection",
        passed: true,
      })}\n`,
    );
  } finally {
    await observer.end();
  }
};

export const program = Effect.promise(run);
