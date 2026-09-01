import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const databaseRoot = join(repositoryRoot, "packages", "database");
const require = createRequire(join(repositoryRoot, "packages/database/package.json"));
const { Pool } = require("pg");
const postgresUrl = process.env.PROFILE_E2E_PG_URL;
const dashboardOrigin = process.env.PROFILE_E2E_DASHBOARD_ORIGIN ?? "http://127.0.0.1:5194";
assert.ok(postgresUrl, "PROFILE_E2E_PG_URL is required");
const parsed = new URL(postgresUrl);
assert.ok(
  ["postgres:", "postgresql:"].includes(parsed.protocol),
  "Profile seed requires PostgreSQL",
);
assert.ok(
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname),
  "Profile seed requires loopback PostgreSQL",
);
assert.match(
  decodeURIComponent(parsed.pathname.slice(1)),
  /^profile_e2e_0064$/u,
  "Profile seed requires disposable profile_e2e_0064 database",
);

export const profilePerson = {
  personId: "profile-self-edit-e2e-0064",
  firstName: "Ada",
  lastName: "Profile",
  email: "profile-before-0064@example.invalid",
  password: "profile-e2e-0064-disposable-password",
};
const departmentId = "profile-self-edit-department-0064";
const teamId = "profile-self-edit-team-0064";
const membershipId = "profile-self-edit-membership-0064";

const identity = spawnSync("bun", ["run", "identity:seed"], {
  cwd: databaseRoot,
  env: {
    ...process.env,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify([profilePerson]),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ?? "profile-e2e-0064-disposable-secret-0123456789",
  },
  encoding: "utf8",
});
assert.equal(identity.status, 0, `identity:seed failed:\n${identity.stdout}\n${identity.stderr}`);
const identityEvidence = JSON.parse(identity.stdout.trim().split("\n").at(-1));

const pool = new Pool({
  connectionString: postgresUrl,
  options: "-c search_path=public",
  max: 1,
  application_name: "native-profile-self-edit-seed-0064",
});
try {
  await pool.query("BEGIN");
  await pool.query("DELETE FROM organization_memberships WHERE membership_id = $1", [membershipId]);
  await pool.query("DELETE FROM organization_teams WHERE team_id = $1", [teamId]);
  await pool.query("DELETE FROM organization_departments WHERE department_id = $1", [departmentId]);
  await pool.query(
    `INSERT INTO person_contact_profiles (person_id, email, phone, revision)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (person_id) DO UPDATE SET email = EXCLUDED.email, phone = EXCLUDED.phone, revision = 0`,
    [profilePerson.personId, profilePerson.email, "+47 9000 0001"],
  );
  await pool.query(
    `INSERT INTO organization_departments (department_id, name, short_name, email, city, active, revision)
     VALUES ($1, 'Profile Evidence', 'P064', 'profile-department-0064@example.invalid', 'Oslo', TRUE, 0)`,
    [departmentId],
  );
  await pool.query(
    `INSERT INTO organization_teams (team_id, department_id, name, active, revision)
     VALUES ($1, $2, 'Profile Evidence Team', TRUE, 0)`,
    [teamId, departmentId],
  );
  await pool.query(
    `INSERT INTO organization_memberships
      (membership_id, person_id, team_id, deleted_team_name, start_at, end_at, position_id, is_team_leader, is_suspended, revision)
     VALUES ($1, $2, $3, NULL, '2020-01-01T00:00:00.000Z', NULL, 'member', FALSE, FALSE, 0)`,
    [membershipId, profilePerson.personId, teamId],
  );
  await pool.query("COMMIT");
  const { rows } = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM auth."user" WHERE id = $1) AS users,
      (SELECT count(*)::int FROM person_profiles WHERE person_id = $1) AS profiles,
      (SELECT count(*)::int FROM person_contact_profiles WHERE person_id = $1) AS contacts,
      (SELECT count(*)::int FROM organization_memberships WHERE membership_id = $2 AND person_id = $1) AS memberships,
      to_regclass('public.profile_self_edit_commands') IS NOT NULL AS profile_commands,
      to_regclass('public.person_profiles') IS NOT NULL AS person_profiles,
      to_regclass('public.person_contact_profiles') IS NOT NULL AS person_contacts`,
    [profilePerson.personId, membershipId],
  );
  assert.deepEqual(rows[0], {
    users: 1,
    profiles: 1,
    contacts: 1,
    memberships: 1,
    profile_commands: true,
    person_profiles: true,
    person_contacts: true,
  });
  process.stdout.write(
    `${JSON.stringify({ specId: "0064", seeded: { personId: profilePerson.personId, departmentId, teamId, membershipId }, values: { before: { firstName: profilePerson.firstName, lastName: profilePerson.lastName, email: profilePerson.email, phone: "+47 9000 0001", nameRevision: 0, contactRevision: 0 }, after: { firstName: "Ada Updated", lastName: "Profile Updated", email: "profile-after-0064@example.invalid", phone: "+47 9000 0002", nameRevision: 1, contactRevision: 1 } }, migration: { schemaRevision: identityEvidence.schemaRevision, tables: rows[0] } })}\n`,
  );
} catch (cause) {
  await pool.query("ROLLBACK").catch(() => undefined);
  throw cause;
} finally {
  await pool.end();
}
