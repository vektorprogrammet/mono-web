/**
 * Seed verification for the specs 0059/0060 native journeys. Applies
 * parameterized fixture rows to a loopback PostgreSQL and verifies every fact
 * the two journey specs depend on. Usage:
 *   node native-team-interest-mailing-list-seed.mjs
 * Requires JOURNEY_SEED_PG_URL (defaults to postgres://postgres@127.0.0.1:45158/postgres).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

const fixtureEmail = (localPart) => [localPart, ["example", "invalid"].join(".")].join("@");
const fixturePhone = (suffix) => ["+47", "900", "59", suffix].join(" ");

export const journeyPersons = {
  admin: {
    personId: "person-0059-admin",
    email: fixtureEmail("admin.0059"),
    password: "journey-secret-0123456789abcdef",
    name: "Astrid Adminsen",
  },
  leader: {
    personId: "person-0059-leader",
    email: fixtureEmail("leader.0059"),
    password: "journey-secret-0123456789abcdef",
    name: "Lars Ledersen",
  },
  member: {
    personId: "person-0059-member",
    email: fixtureEmail("member.0059"),
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

const parameterRows = (rows) => {
  let index = 0;
  return rows
    .map((row) => `(${row.map(() => `$${(index += 1)}`).join(", ")})`)
    .join(",\n");
};

const insertRows = (client, statement, rows, conflictClause = "") =>
  client.query(
    `${statement}\nVALUES\n${parameterRows(rows)}\n${conflictClause}`,
    rows.flat(),
  );

const assert = (condition, message) => {
  if (!condition) throw new Error(`journey seed assertion failed: ${message}`);
};

async function main() {
  const observer = new Pool({
    connectionString: postgresUrl,
    options: "-c search_path=public",
    max: 1,
    application_name: "native-team-interest-mailing-list-seed",
  });
  const client = await observer.connect();
  try {
    await client.query("BEGIN");
    await insertRows(
      client,
      "INSERT INTO organization_departments (department_id, name, short_name, email, city, active, revision)",
      [
        [
          departments.trondheim,
          "Vektorprogrammet Trondheim",
          "Trondheim",
          fixtureEmail("trondheim.0059"),
          "Trondheim",
          true,
          0,
        ],
        [
          departments.bergen,
          "Vektorprogrammet Bergen",
          "Bergen",
          fixtureEmail("bergen.0059"),
          "Bergen",
          true,
          0,
        ],
      ],
      "ON CONFLICT (department_id) DO NOTHING",
    );
    await insertRows(
      client,
      "INSERT INTO organization_teams (team_id, department_id, name, active, revision)",
      [
        [teams.it, departments.trondheim, "IT-Team 0059", true, 0],
        [teams.pr, departments.trondheim, "PR-Team 0059", true, 0],
        [teams.skole, departments.bergen, "SkoleTeam 0059", true, 0],
      ],
      "ON CONFLICT (team_id) DO NOTHING",
    );
    await insertRows(
      client,
      "INSERT INTO person_profiles (person_id, first_name, last_name, revision)",
      [
        [journeyPersons.admin.personId, "Astrid", "Adminsen", 0],
        [journeyPersons.leader.personId, "Lars", "Ledersen", 0],
        [journeyPersons.member.personId, "Mona", "Medlem", 0],
        ["person-0059-team1a", "Tiril", "Teamsen", 0],
        ["person-0059-team1b", "Torunn", "Teamto", 0],
        ["person-0059-team2a", "Thea", "Trondheim", 0],
        ["person-0059-assistant", "Are", "Assistent", 0],
      ],
      "ON CONFLICT (person_id) DO NOTHING",
    );
    await insertRows(
      client,
      "INSERT INTO person_contact_profiles (person_id, email, phone, revision)",
      [
        [journeyPersons.admin.personId, fixtureEmail("astrid.admin"), fixturePhone("001"), 0],
        [journeyPersons.leader.personId, fixtureEmail("lars.leader"), fixturePhone("002"), 0],
        [journeyPersons.member.personId, fixtureEmail("mona.member"), fixturePhone("003"), 0],
        ["person-0059-team1a", fixtureEmail("tiril.team"), fixturePhone("004"), 0],
        ["person-0059-team1b", fixtureEmail("torunn.team"), fixturePhone("005"), 0],
        ["person-0059-team2a", fixtureEmail("thea.crew"), fixturePhone("006"), 0],
      ],
      "ON CONFLICT (person_id) DO NOTHING",
    );
    await client.query(
      "DELETE FROM organization_memberships WHERE membership_id = $1",
      ["membership-0059-team2a-skole"],
    );
    await insertRows(
      client,
      "INSERT INTO organization_memberships (membership_id, person_id, team_id, deleted_team_name, start_at, end_at, position_id, is_team_leader, is_suspended, revision)",
      [
        [
          "membership-0059-admin-it",
          journeyPersons.admin.personId,
          teams.it,
          null,
          "2026-01-01T00:00:00Z",
          null,
          "medlem",
          false,
          false,
          0,
        ],
        [
          "membership-0059-leader-it",
          journeyPersons.leader.personId,
          teams.it,
          null,
          "2026-01-01T00:00:00Z",
          null,
          "teamleader",
          true,
          false,
          0,
        ],
        [
          "membership-0059-member-pr",
          journeyPersons.member.personId,
          teams.pr,
          null,
          "2026-01-01T00:00:00Z",
          null,
          "medlem",
          false,
          false,
          0,
        ],
        [
          "membership-0059-team1a-it",
          "person-0059-team1a",
          teams.it,
          null,
          "2026-01-01T00:00:00Z",
          null,
          "medlem",
          false,
          false,
          0,
        ],
        [
          "membership-0059-team1b-pr",
          "person-0059-team1b",
          teams.pr,
          null,
          "2026-01-01T00:00:00Z",
          null,
          "medlem",
          false,
          false,
          0,
        ],
        [
          "membership-0059-bergen-leader",
          "person-0059-assistant",
          teams.skole,
          null,
          "2026-01-01T00:00:00Z",
          null,
          "teamleader",
          true,
          false,
          0,
        ],
      ],
      "ON CONFLICT (membership_id) DO NOTHING",
    );
    await insertRows(
      client,
      "INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at, end_at, revision)",
      [
        [
          "grant-0059-admin",
          journeyPersons.admin.personId,
          "2026-01-01T00:00:00Z",
          null,
          0,
        ],
      ],
      "ON CONFLICT (grant_id) DO NOTHING",
    );
    // Registrations have no natural key; clear prior journey rows so reruns
    // preserve the exact provisioning asserted below.
    await client.query("DELETE FROM organization_team_interest_registrations");
    await insertRows(
      client,
      "INSERT INTO organization_team_interest_registrations (submitter_name, submitter_email, team_id, department_id, semester_id, submitted_at, revision)",
      [
        [
          "Sondre Soker",
          fixtureEmail("sondre.soker"),
          teams.it,
          departments.trondheim,
          null,
          "2026-08-10T10:00:00Z",
          0,
        ],
        [
          "Sigrid Storm",
          fixtureEmail("sigrid.storm"),
          teams.it,
          departments.trondheim,
          null,
          "2026-08-11T11:30:00Z",
          0,
        ],
        [
          "Sverre Strand",
          fixtureEmail("sverre.strand"),
          teams.pr,
          departments.trondheim,
          null,
          "2026-08-12T09:15:00Z",
          0,
        ],
        [
          "Bjornar Bergen",
          fixtureEmail("bjornar.bergen"),
          teams.skole,
          departments.bergen,
          null,
          "2026-08-13T14:45:00Z",
          0,
        ],
      ],
    );
    await client.query("COMMIT");

    const checks = await client.query(
      `
        SELECT
          (SELECT count(*) FROM organization_team_interest_registrations) AS registrations_total,
          (SELECT count(*) FROM organization_team_interest_registrations WHERE department_id = $1) AS registrations_trondheim,
          (SELECT count(*) FROM organization_team_interest_registrations WHERE department_id = $2) AS registrations_bergen,
          (SELECT count(*) FROM organization_memberships m WHERE m.person_id = $3 AND m.is_team_leader AND NOT m.is_suspended) AS leader_scoped_memberships,
          (SELECT count(*) FROM organization_global_administrator_grants g WHERE g.person_id = $4 AND g.start_at <= now() AND (g.end_at IS NULL OR now() < g.end_at)) AS admin_grants,
          (SELECT count(*) FROM person_contact_profiles) AS contacts,
          (SELECT count(*) FROM auth."user" u WHERE u.id IN ($5, $6, $7)) AS auth_users
      `,
      [
        departments.trondheim,
        departments.bergen,
        journeyPersons.leader.personId,
        journeyPersons.admin.personId,
        journeyPersons.admin.personId,
        journeyPersons.leader.personId,
        journeyPersons.member.personId,
      ],
    );
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
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
    await observer.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
