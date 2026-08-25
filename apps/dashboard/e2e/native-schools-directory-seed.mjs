import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));
const databaseRequire = createRequire(
  new URL("../../../packages/database/package.json", import.meta.url),
);
const { Pool } = databaseRequire("pg");
const postgresUrl = process.env.SCHOOLS_E2E_PG_URL;
const dashboardOrigin = process.env.SCHOOLS_E2E_DASHBOARD_ORIGIN ?? "http://127.0.0.1:45161";
if (postgresUrl === undefined) throw new Error("SCHOOLS_E2E_PG_URL is required");

const parsedUrl = new URL(postgresUrl);
assert.ok(
  parsedUrl.protocol === "postgres:" || parsedUrl.protocol === "postgresql:",
  "Schools seed requires PostgreSQL",
);
assert.ok(
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedUrl.hostname),
  "Schools seed is restricted to loopback PostgreSQL",
);
assert.match(
  decodeURIComponent(parsedUrl.pathname.slice(1)),
  /^schools_e2e_0061$/u,
  "Schools seed requires the disposable schools_e2e_0061 database",
);

export const schoolsJourneyPersons = {
  administrator: {
    personId: "schools-e2e-0061-administrator",
    firstName: "Ada",
    lastName: "Administrator",
    email: "administrator.schools.0061@example.invalid",
    password: "schools-admin-0061-password",
  },
  twoDepartmentMember: {
    personId: "schools-e2e-0061-two-departments",
    firstName: "Tora",
    lastName: "Toavdelinger",
    email: "two-departments.schools.0061@example.invalid",
    password: "schools-two-0061-password",
  },
  oneDepartmentMember: {
    personId: "schools-e2e-0061-one-department",
    firstName: "Einar",
    lastName: "Enavdeling",
    email: "one-department.schools.0061@example.invalid",
    password: "schools-one-0061-password",
  },
  endedOnlyMember: {
    personId: "schools-e2e-0061-ended-only",
    firstName: "Ingrid",
    lastName: "Inaktiv",
    email: "ended-only.schools.0061@example.invalid",
    password: "schools-ended-0061-password",
  },
  noAuthority: {
    personId: "schools-e2e-0061-no-authority",
    firstName: "Nils",
    lastName: "Utenrolle",
    email: "no-authority.schools.0061@example.invalid",
    password: "schools-none-0061-password",
  },
};

export const schoolsJourneyDepartments = {
  alpha: "schools-e2e-0061-department-alpha",
  beta: "schools-e2e-0061-department-beta",
  empty: "schools-e2e-0061-department-empty",
};

const persons = Object.values(schoolsJourneyPersons);
const personIds = persons.map((person) => person.personId);
const departmentIds = Object.values(schoolsJourneyDepartments);
const teamIds = ["schools-e2e-0061-team-alpha", "schools-e2e-0061-team-beta"];
const membershipIds = [
  "schools-e2e-0061-membership-two-alpha",
  "schools-e2e-0061-membership-two-beta",
  "schools-e2e-0061-membership-one-alpha",
  "schools-e2e-0061-membership-ended-alpha",
];

const identitySeed = spawnSync("bun", ["run", "identity:seed"], {
  cwd: databaseRoot,
  env: {
    ...process.env,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify(persons),
    BETTER_AUTH_URL: dashboardOrigin,
  },
  encoding: "utf8",
});
assert.equal(
  identitySeed.status,
  0,
  `identity:seed failed:\n${identitySeed.stdout}\n${identitySeed.stderr}`,
);

const pool = new Pool({
  connectionString: postgresUrl,
  options: "-c search_path=public",
  max: 1,
  application_name: "native-schools-directory-seed-0061",
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("DELETE FROM schools_directory_schools");
  await client.query("DELETE FROM organization_memberships WHERE membership_id = ANY($1::text[])", [
    membershipIds,
  ]);
  await client.query("DELETE FROM organization_global_administrator_grants WHERE grant_id = $1", [
    "schools-e2e-0061-administrator-grant",
  ]);
  await client.query("DELETE FROM organization_teams WHERE team_id = ANY($1::text[])", [teamIds]);
  await client.query("DELETE FROM organization_departments WHERE department_id = ANY($1::text[])", [
    departmentIds,
  ]);

  await client.query(
    `INSERT INTO organization_departments (
      department_id, name, short_name, email, city, active, revision
    ) VALUES
      ($1, 'Avdeling Alfa', 'ALFA', 'alpha.schools.0061@example.invalid', 'Oslo', TRUE, 0),
      ($2, 'Avdeling Beta', 'BETA', 'beta.schools.0061@example.invalid', 'Bergen', TRUE, 0),
      ($3, 'Avdeling Uten Skole', 'TOM', 'empty.schools.0061@example.invalid', 'Tromsø', TRUE, 0)`,
    [
      schoolsJourneyDepartments.alpha,
      schoolsJourneyDepartments.beta,
      schoolsJourneyDepartments.empty,
    ],
  );
  await client.query(
    `INSERT INTO organization_teams (team_id, department_id, name, active, revision)
     VALUES
       ($1, $2, 'Team Alfa', TRUE, 0),
       ($3, $4, 'Team Beta', TRUE, 0)`,
    [teamIds[0], schoolsJourneyDepartments.alpha, teamIds[1], schoolsJourneyDepartments.beta],
  );
  await client.query(
    `INSERT INTO person_contact_profiles (person_id, email, phone, revision)
     SELECT seed.person_id, seed.email, seed.phone, 0
     FROM unnest($1::text[], $2::text[], $3::text[]) AS seed(person_id, email, phone)
     ON CONFLICT (person_id) DO UPDATE
     SET email = EXCLUDED.email, phone = EXCLUDED.phone`,
    [
      personIds,
      persons.map((person) => person.email),
      persons.map((_, index) => `+47 906 10 06${index}`),
    ],
  );
  await client.query(
    `INSERT INTO organization_global_administrator_grants (
      grant_id, person_id, start_at, end_at, revision
    ) VALUES ($1, $2, '2020-01-01T00:00:00.000Z', NULL, 0)`,
    ["schools-e2e-0061-administrator-grant", schoolsJourneyPersons.administrator.personId],
  );
  await client.query(
    `INSERT INTO organization_memberships (
      membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
      position_id, is_team_leader, is_suspended, revision
    ) VALUES
      ($1, $2, $3, NULL, '2020-01-01T00:00:00.000Z', NULL, 'member', FALSE, FALSE, 0),
      ($4, $2, $5, NULL, '2020-01-01T00:00:00.000Z', NULL, 'member', FALSE, FALSE, 0),
      ($6, $7, $3, NULL, '2020-01-01T00:00:00.000Z', NULL, 'member', FALSE, FALSE, 0),
      ($8, $9, $3, NULL, '2020-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z',
       'member', FALSE, FALSE, 0)`,
    [
      membershipIds[0],
      schoolsJourneyPersons.twoDepartmentMember.personId,
      teamIds[0],
      membershipIds[1],
      teamIds[1],
      membershipIds[2],
      schoolsJourneyPersons.oneDepartmentMember.personId,
      membershipIds[3],
      schoolsJourneyPersons.endedOnlyMember.personId,
    ],
  );
  await client.query(
    `INSERT INTO schools_directory_schools (
      school_id, name, contact_person, email, phone, language, active, revision
    ) OVERRIDING SYSTEM VALUE VALUES
      (6101, 'Alfaskolen', 'Ada Lovelace', 'ada@alfaskolen.example.invalid', '+47 610 10 001',
       'Norwegian', TRUE, 0),
      (6102, 'Betaskolen', 'Bente Bjerke', 'bente@betaskolen.example.invalid', '+47 610 10 002',
       'International', TRUE, 0),
      (6103, 'Fellesskolen', 'Frida Felles', 'frida@fellesskolen.example.invalid', '+47 610 10 003',
       'Norwegian', TRUE, 0),
      (6104, 'Friskolen', 'Una Uavhengig', 'una@friskolen.example.invalid', '+47 610 10 004',
       'International', TRUE, 0),
      (6105, 'Gamleskolen', 'Grete Gammel', 'grete@gamleskolen.example.invalid', '+47 610 10 005',
       'Norwegian', FALSE, 0),
      (6106, 'Historisk Internasjonal', 'Henrik Historie',
       'henrik@historisk.example.invalid', '+47 610 10 006', 'International', FALSE, 0)`,
  );
  await client.query(
    `INSERT INTO schools_directory_departments (school_id, department_id, revision)
     VALUES
       (6101, $1, 0),
       (6102, $2, 0),
       (6103, $1, 0),
       (6103, $2, 0),
       (6105, $1, 0),
       (6106, $2, 0)`,
    [schoolsJourneyDepartments.alpha, schoolsJourneyDepartments.beta],
  );
  await client.query(
    `SELECT setval(
      pg_get_serial_sequence('schools_directory_schools', 'school_id'),
      (SELECT max(school_id) FROM schools_directory_schools),
      TRUE
    )`,
  );
  await client.query("COMMIT");

  const evidence = await client.query(
    `SELECT
      (SELECT count(*)::int FROM auth."user" WHERE id = ANY($1::text[])) AS persons,
      (SELECT count(*)::int FROM organization_departments WHERE department_id = ANY($2::text[]))
        AS departments,
      (SELECT count(*)::int FROM organization_memberships WHERE membership_id = ANY($3::text[]))
        AS memberships,
      (SELECT count(*)::int FROM schools_directory_schools) AS schools,
      (SELECT count(*)::int FROM schools_directory_schools WHERE active) AS active_schools,
      (SELECT count(*)::int FROM schools_directory_schools WHERE NOT active) AS inactive_schools,
      (SELECT count(*)::int FROM schools_directory_schools AS school
       WHERE NOT EXISTS (
         SELECT 1 FROM schools_directory_departments AS association
         WHERE association.school_id = school.school_id
       )) AS unassigned_schools,
      (SELECT count(*)::int FROM schools_directory_departments WHERE school_id = 6103)
        AS shared_associations,
      (SELECT count(*)::int FROM schools_directory_departments
       WHERE department_id = $4) AS empty_department_associations`,
    [personIds, departmentIds, membershipIds, schoolsJourneyDepartments.empty],
  );
  assert.deepEqual(evidence.rows[0], {
    persons: 5,
    departments: 3,
    memberships: 4,
    schools: 6,
    active_schools: 4,
    inactive_schools: 2,
    unassigned_schools: 1,
    shared_associations: 2,
    empty_department_associations: 0,
  });
  process.stdout.write(`${JSON.stringify({ passed: true, ...evidence.rows[0] })}\n`);
} catch (cause) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw cause;
} finally {
  client.release();
  await pool.end();
}
