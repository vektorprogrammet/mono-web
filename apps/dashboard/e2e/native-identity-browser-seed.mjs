import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const databaseRoot = join(repositoryRoot, "packages", "database");
const require = createRequire(join(repositoryRoot, "packages/database/package.json"));
const { Pool } = require("pg");

const postgresUrl = process.env.IDENTITY_EVIDENCE_PG_URL;
const password = process.env.IDENTITY_EVIDENCE_PASSWORD;
assert.equal(typeof postgresUrl, "string", "IDENTITY_EVIDENCE_PG_URL is required");
assert.equal(typeof password, "string", "IDENTITY_EVIDENCE_PASSWORD is required");
assert.ok(
  password.length >= 12,
  "IDENTITY_EVIDENCE_PASSWORD must satisfy Better Auth minimum length",
);
const parsedUrl = new URL(postgresUrl);
assert.ok(["postgres:", "postgresql:"].includes(parsedUrl.protocol));
assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedUrl.hostname));

export const identityEvidencePersona = {
  personId: "journey-0065-admin",
  firstName: "Journey",
  lastName: "Identity",
  email: "admin.identity-0065@example.invalid",
};
const grantId = "grant-journey-0065-admin";
const phone = "+47 900 00 065";

const seed = spawnSync("bun", ["run", "identity:seed"], {
  cwd: databaseRoot,
  env: {
    ...process.env,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify([{ ...identityEvidencePersona, password }]),
  },
  encoding: "utf8",
});
assert.equal(seed.status, 0, `identity:seed failed (${seed.status ?? "signal"})`);

const observer = new Pool({
  connectionString: postgresUrl,
  options: "-c search_path=public",
  max: 1,
  application_name: "identity-browser-0065-seed-observer",
});
try {
  await observer.query("BEGIN");
  await observer.query(
    `INSERT INTO public.person_contact_profiles (person_id, email, phone, revision)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (person_id) DO NOTHING`,
    [identityEvidencePersona.personId, identityEvidencePersona.email, phone],
  );
  await observer.query(
    `INSERT INTO auth.organization_global_administrator_grants
      (grant_id, person_id, start_at, end_at, revision)
     VALUES ($1, $2, TIMESTAMPTZ '2026-01-01T00:00:00Z', NULL, 0)
     ON CONFLICT (grant_id) DO NOTHING`,
    [grantId, identityEvidencePersona.personId],
  );
  await observer.query("COMMIT");

  const result = await observer.query(
    `SELECT
       (SELECT count(*) FROM public.person_profiles WHERE person_id = $1) AS profiles,
       (SELECT count(*) FROM public.person_contact_profiles WHERE person_id = $1) AS contacts,
       (SELECT count(*) FROM auth.organization_global_administrator_grants
          WHERE person_id = $1 AND start_at <= now() AND (end_at IS NULL OR now() < end_at)) AS grants,
       (SELECT count(*) FROM auth."user" WHERE id = $1) AS users,
       (SELECT count(*) FROM auth.account WHERE "userId" = $1 AND "providerId" = 'credential') AS accounts,
       (SELECT count(*) FROM public.vektorprogrammet_schema_migrations
          WHERE migration_id = 15 AND name = 'native-identity-better-auth') AS identity_migration,
       (SELECT count(*) FROM public.vektorprogrammet_schema_migrations) AS applied_migrations`,
    [identityEvidencePersona.personId],
  );
  const row = result.rows[0];
  assert.equal(Number(row.profiles), 1);
  assert.equal(Number(row.contacts), 1);
  assert.equal(Number(row.grants), 1);
  assert.equal(Number(row.users), 1);
  assert.equal(Number(row.accounts), 1);
  assert.equal(Number(row.identity_migration), 1);
  assert.ok(Number(row.applied_migrations) >= 15);

  process.stdout.write(
    `${JSON.stringify({
      personId: identityEvidencePersona.personId,
      emailClass: "synthetic.invalid",
      displayName: "Journey Identity",
      migration: { revision: 15, name: "native-identity-better-auth" },
      rows: {
        profiles: 1,
        contacts: 1,
        globalAdministratorGrants: 1,
        users: 1,
        credentialAccounts: 1,
      },
      account: "created-or-existing",
    })}\n`,
  );
} catch (error) {
  await observer.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await observer.end();
}
