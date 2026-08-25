/**
 * Seed verification for the specs 0059/0060 native journeys. Applies
 * parameterized fixture rows to a loopback PostgreSQL and verifies every fact
 * the two journey specs depend on. Usage:
 *   node native-team-interest-mailing-list-seed.mjs
 * Requires JOURNEY_SEED_PG_URL (defaults to postgres://postgres@127.0.0.1:45158/postgres).
 */
import { readFile } from "node:fs/promises";
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

const seedStatementNames = Object.freeze([
  "seed_departments",
  "seed_teams",
  "seed_person_profiles",
  "seed_person_contact_profiles",
  "seed_memberships",
  "seed_global_administrator_grants",
  "seed_team_interest_registrations",
]);

const parseSeedStatements = (source) => {
  const markers = [...source.matchAll(/^-- name: ([a-z][a-z0-9_]*)\r?$/gm)];
  if (markers.length !== seedStatementNames.length || markers[0]?.index !== 0) {
    throw new Error("seed SQL authority must contain exactly the named statements");
  }

  const statements = new Map();
  for (const [index, marker] of markers.entries()) {
    const name = marker[1];
    const start = marker.index + marker[0].length;
    const end = markers[index + 1]?.index ?? source.length;
    const statement = source.slice(start, end).trim();
    if (
      statement.length === 0 ||
      !statement.endsWith(";") ||
      statement.slice(0, -1).includes(";") ||
      statements.has(name)
    ) {
      throw new Error(`invalid named seed SQL statement: ${name}`);
    }
    statements.set(name, statement);
  }

  if (
    statements.size !== seedStatementNames.length ||
    seedStatementNames.some((name) => !statements.has(name))
  ) {
    throw new Error("seed SQL authority statement names do not match the required seed operations");
  }
  return statements;
};

const executeSeedRows = (client, statements, name, rows) => {
  const statement = statements.get(name);
  if (statement === undefined) {
    throw new Error(`missing named seed SQL statement: ${name}`);
  }
  return client.query(statement, [JSON.stringify(rows)]);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(`journey seed assertion failed: ${message}`);
};

async function main() {
  const seedStatements = parseSeedStatements(
    await readFile(join(here, "native-team-interest-mailing-list-seed.sql"), "utf8"),
  );
  const observer = new Pool({
    connectionString: postgresUrl,
    options: "-c search_path=public",
    max: 1,
    application_name: "native-team-interest-mailing-list-seed",
  });
  const client = await observer.connect();
  try {
    await client.query("BEGIN");
    await executeSeedRows(client, seedStatements, "seed_departments", [
      {
        department_id: departments.trondheim,
        name: "Vektorprogrammet Trondheim",
        short_name: "Trondheim",
        email: fixtureEmail("trondheim.0059"),
        city: "Trondheim",
        active: true,
        revision: 0,
      },
      {
        department_id: departments.bergen,
        name: "Vektorprogrammet Bergen",
        short_name: "Bergen",
        email: fixtureEmail("bergen.0059"),
        city: "Bergen",
        active: true,
        revision: 0,
      },
    ]);
    await executeSeedRows(client, seedStatements, "seed_teams", [
      {
        team_id: teams.it,
        department_id: departments.trondheim,
        name: "IT-Team 0059",
        active: true,
        revision: 0,
      },
      {
        team_id: teams.pr,
        department_id: departments.trondheim,
        name: "PR-Team 0059",
        active: true,
        revision: 0,
      },
      {
        team_id: teams.skole,
        department_id: departments.bergen,
        name: "SkoleTeam 0059",
        active: true,
        revision: 0,
      },
    ]);
    await executeSeedRows(client, seedStatements, "seed_person_profiles", [
      {
        person_id: journeyPersons.admin.personId,
        first_name: "Astrid",
        last_name: "Adminsen",
        revision: 0,
      },
      {
        person_id: journeyPersons.leader.personId,
        first_name: "Lars",
        last_name: "Ledersen",
        revision: 0,
      },
      {
        person_id: journeyPersons.member.personId,
        first_name: "Mona",
        last_name: "Medlem",
        revision: 0,
      },
      {
        person_id: "person-0059-team1a",
        first_name: "Tiril",
        last_name: "Teamsen",
        revision: 0,
      },
      {
        person_id: "person-0059-team1b",
        first_name: "Torunn",
        last_name: "Teamto",
        revision: 0,
      },
      {
        person_id: "person-0059-team2a",
        first_name: "Thea",
        last_name: "Trondheim",
        revision: 0,
      },
      {
        person_id: "person-0059-assistant",
        first_name: "Are",
        last_name: "Assistent",
        revision: 0,
      },
    ]);
    await executeSeedRows(client, seedStatements, "seed_person_contact_profiles", [
      {
        person_id: journeyPersons.admin.personId,
        email: fixtureEmail("astrid.admin"),
        phone: fixturePhone("001"),
        revision: 0,
      },
      {
        person_id: journeyPersons.leader.personId,
        email: fixtureEmail("lars.leader"),
        phone: fixturePhone("002"),
        revision: 0,
      },
      {
        person_id: journeyPersons.member.personId,
        email: fixtureEmail("mona.member"),
        phone: fixturePhone("003"),
        revision: 0,
      },
      {
        person_id: "person-0059-team1a",
        email: fixtureEmail("tiril.team"),
        phone: fixturePhone("004"),
        revision: 0,
      },
      {
        person_id: "person-0059-team1b",
        email: fixtureEmail("torunn.team"),
        phone: fixturePhone("005"),
        revision: 0,
      },
      {
        person_id: "person-0059-team2a",
        email: fixtureEmail("thea.crew"),
        phone: fixturePhone("006"),
        revision: 0,
      },
      // The Bergen assistant deliberately has no contact profile.
    ]);
    await client.query("DELETE FROM organization_memberships WHERE membership_id = $1", [
      "membership-0059-team2a-skole",
    ]);
    await executeSeedRows(client, seedStatements, "seed_memberships", [
      {
        membership_id: "membership-0059-admin-it",
        person_id: journeyPersons.admin.personId,
        team_id: teams.it,
        deleted_team_name: null,
        start_at: "2026-01-01T00:00:00Z",
        end_at: null,
        position_id: "medlem",
        is_team_leader: false,
        is_suspended: false,
        revision: 0,
      },
      {
        membership_id: "membership-0059-leader-it",
        person_id: journeyPersons.leader.personId,
        team_id: teams.it,
        deleted_team_name: null,
        start_at: "2026-01-01T00:00:00Z",
        end_at: null,
        position_id: "teamleader",
        is_team_leader: true,
        is_suspended: false,
        revision: 0,
      },
      {
        membership_id: "membership-0059-member-pr",
        person_id: journeyPersons.member.personId,
        team_id: teams.pr,
        deleted_team_name: null,
        start_at: "2026-01-01T00:00:00Z",
        end_at: null,
        position_id: "medlem",
        is_team_leader: false,
        is_suspended: false,
        revision: 0,
      },
      {
        membership_id: "membership-0059-team1a-it",
        person_id: "person-0059-team1a",
        team_id: teams.it,
        deleted_team_name: null,
        start_at: "2026-01-01T00:00:00Z",
        end_at: null,
        position_id: "medlem",
        is_team_leader: false,
        is_suspended: false,
        revision: 0,
      },
      {
        membership_id: "membership-0059-team1b-pr",
        person_id: "person-0059-team1b",
        team_id: teams.pr,
        deleted_team_name: null,
        start_at: "2026-01-01T00:00:00Z",
        end_at: null,
        position_id: "medlem",
        is_team_leader: false,
        is_suspended: false,
        revision: 0,
      },
      {
        membership_id: "membership-0059-bergen-leader",
        person_id: "person-0059-assistant",
        team_id: teams.skole,
        deleted_team_name: null,
        start_at: "2026-01-01T00:00:00Z",
        end_at: null,
        position_id: "teamleader",
        is_team_leader: true,
        is_suspended: false,
        revision: 0,
      },
    ]);
    await executeSeedRows(client, seedStatements, "seed_global_administrator_grants", [
      {
        grant_id: "grant-0059-admin",
        person_id: journeyPersons.admin.personId,
        start_at: "2026-01-01T00:00:00Z",
        end_at: null,
        revision: 0,
      },
    ]);
    // Registrations have no natural key; clear prior journey rows so reruns
    // preserve the exact provisioning asserted below.
    await client.query("DELETE FROM organization_team_interest_registrations");
    await executeSeedRows(client, seedStatements, "seed_team_interest_registrations", [
      {
        submitter_name: "Sondre Soker",
        submitter_email: fixtureEmail("sondre.soker"),
        team_id: teams.it,
        department_id: departments.trondheim,
        semester_id: null,
        submitted_at: "2026-08-10T10:00:00Z",
        revision: 0,
      },
      {
        submitter_name: "Sigrid Storm",
        submitter_email: fixtureEmail("sigrid.storm"),
        team_id: teams.it,
        department_id: departments.trondheim,
        semester_id: null,
        submitted_at: "2026-08-11T11:30:00Z",
        revision: 0,
      },
      {
        submitter_name: "Sverre Strand",
        submitter_email: fixtureEmail("sverre.strand"),
        team_id: teams.pr,
        department_id: departments.trondheim,
        semester_id: null,
        submitted_at: "2026-08-12T09:15:00Z",
        revision: 0,
      },
      {
        submitter_name: "Bjornar Bergen",
        submitter_email: fixtureEmail("bjornar.bergen"),
        team_id: teams.skole,
        department_id: departments.bergen,
        semester_id: null,
        submitted_at: "2026-08-13T14:45:00Z",
        revision: 0,
      },
    ]);
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
