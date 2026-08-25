/**
 * Seed verification for the specs 0059/0060 native journeys. Applies the SQL
 * seed next to this file against a loopback PostgreSQL and asserts every fact
 * the two journey specs depend on. Usage:
 *   node native-team-interest-mailing-list-seed.mjs
 * Requires JOURNEY_SEED_PG_URL (defaults to postgres://postgres@127.0.0.1:45158/postgres).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// `pg` is a dependency of the database package; resolve from there so this
// dashboard-side support script adds no new package dependency.
const require = createRequire(join(here, "../../..", "packages/database/package.json"));
const { Pool } = require("pg");

const postgresUrl =
  process.env.JOURNEY_SEED_PG_URL ?? "postgres://postgres@127.0.0.1:45158/postgres";

const parsedUrl = new URL(postgresUrl);
if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
  throw new Error("JOURNEY_SEED_PG_URL must use PostgreSQL");
}
if (!["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
  throw new Error("journey seed is restricted to loopback PostgreSQL");
}

export const journeyPersons = {
  admin: {
    personId: "person-0059-admin",
    email: "admin.0059@example.invalid",
    password: "journey-secret-0123456789abcdef",
    name: "Astrid Adminsen",
  },
  leader: {
    personId: "person-0059-leader",
    email: "leader.0059@example.invalid",
    password: "journey-secret-0123456789abcdef",
    name: "Lars Ledersen",
  },
  member: {
    personId: "person-0059-member",
    email: "member.0059@example.invalid",
    password: "journey-secret-0123456789abcdef",
    name: "Mona Medlem",
  },
};

export const departments = {
  trondheim: "department-0059-trondheim",
  bergen: "department-0059-bergen",
};

export const teams = {
  it: "team-0059-it",
  pr: "team-0059-pr",
  skole: "team-0059-skole",
};

/** Trondheim registrations (leader + admin scope); Bergen is admin-only. */
export const registrationCounts = { total: 4, trondheim: 3, bergen: 1 };

const assert = (condition, message) => {
  if (!condition) throw new Error(`journey seed assertion failed: ${message}`);
};

async function main() {
  const sql = readFileSync(join(here, "native-team-interest-mailing-list-seed.sql"), "utf8");
  const observer = new Pool({
    connectionString: postgresUrl,
    options: "-c search_path=public",
    max: 1,
    application_name: "native-team-interest-mailing-list-seed",
  });
  try {
    // Registrations have no natural key; clear prior journey rows so the
    // counts assert exact provisioning even across reruns.
    await observer.query("DELETE FROM organization_team_interest_registrations;");
    await observer.query(sql);

    const checks = await observer.query(`
      SELECT
        (SELECT count(*) FROM organization_team_interest_registrations) AS registrations_total,
        (SELECT count(*) FROM organization_team_interest_registrations WHERE department_id = '${departments.trondheim}') AS registrations_trondheim,
        (SELECT count(*) FROM organization_team_interest_registrations WHERE department_id = '${departments.bergen}') AS registrations_bergen,
        (SELECT count(*) FROM organization_memberships m WHERE m.person_id = '${journeyPersons.leader.personId}' AND m.is_team_leader AND NOT m.is_suspended) AS leader_scoped_memberships,
        (SELECT count(*) FROM organization_global_administrator_grants g WHERE g.person_id = '${journeyPersons.admin.personId}' AND g.start_at <= now() AND (g.end_at IS NULL OR now() < g.end_at)) AS admin_grants,
        (SELECT count(*) FROM person_contact_profiles) AS contacts,
        (SELECT count(*) FROM auth."user" u WHERE u.id IN ('${journeyPersons.admin.personId}', '${journeyPersons.leader.personId}', '${journeyPersons.member.personId}')) AS auth_users
    `);
    const counts = checks.rows[0];
    assert(
      Number(counts.registrations_total) === registrationCounts.total,
      "four team-interest registrations",
    );
    assert(
      Number(counts.registrations_trondheim) === registrationCounts.trondheim,
      "three Trondheim registrations",
    );
    assert(
      Number(counts.registrations_bergen) === registrationCounts.bergen,
      "one Bergen registration",
    );
    assert(
      Number(counts.leader_scoped_memberships) === 1,
      "leader holds exactly one active team-leader membership",
    );
    assert(Number(counts.admin_grants) === 1, "admin holds one active global-administrator grant");
    assert(Number(counts.contacts) === 6, "six contact profiles");
    assert(Number(counts.auth_users) === 3, "three login-capable auth users");

    process.stdout.write(
      `${JSON.stringify({ seeded: "native-team-interest-mailing-lists-0059-0060", counts }, null, 2)}\n`,
    );
  } finally {
    await observer.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
