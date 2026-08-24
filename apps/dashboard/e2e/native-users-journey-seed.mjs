/**
 * User-directory journey seed support (spec 0057 on the native Identity stack).
 *
 * Provisions the 0057 browser-journey personas against a DISPOSABLE loopback
 * PostgreSQL database and asserts they satisfy the frozen evidence contract:
 *
 * - one global-administrator person (identity:seed) with an ACTIVE
 *   organization_global_administrator_grants row;
 * - one multi-department person with ACTIVE memberships in teams of TWO
 *   different departments (the directory must hold both in ONE row);
 * - one ended-membership person whose end_at lies STRICTLY BEFORE now (must
 *   land under Inaktive Brukere);
 * - one plain member with an active non-leader membership (typed denial);
 * - one department leader with an ACTIVE leader membership in exactly ONE
 *   department that holds at least one OTHER member (scope intersection);
 * - one further member confined to the leader's NON-member department so the
 *   leader's scoped view must EXCLUDE at least one cross-department row;
 * - person_contact_profiles rows for every seeded person.
 *
 * Login-capable persons are created through the existing identity:seed
 * entrypoint (migrations apply there first); this script only adds the
 * Organization facts around them. Every insert is idempotent
 * (ON CONFLICT DO NOTHING) and every write is asserted by reading it back.
 *
 * Usage:
 *   JOURNEY_SEED_PG_URL=postgres://postgres@127.0.0.1:45157/directory_journey \
 *     bun apps/dashboard/e2e/native-users-journey-seed.mjs
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const databaseRoot = join(repositoryRoot, "packages", "database");

// `pg` is a dependency of the database package; resolve from there so this
// dashboard-side support script adds no new package dependency.
const require = createRequire(join(repositoryRoot, "packages/database/package.json"));
const { Pool } = require("pg");

const postgresUrl =
  process.env.JOURNEY_SEED_PG_URL ?? "postgres://postgres@127.0.0.1:45157/directory_journey";

const parsedUrl = new URL(postgresUrl);
if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
  throw new Error("JOURNEY_SEED_PG_URL must use PostgreSQL");
}
if (!["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
  throw new Error("journey seed is restricted to loopback PostgreSQL");
}

// Journey persona facts. Passwords satisfy better-auth minPasswordLength=12.
export const journeyPersons = {
  admin: {
    personId: "journey-0057-admin",
    firstName: "Journey",
    lastName: "Admin",
    email: "admin.journey@example.invalid",
    password: "journey-secret-2026",
  },
  multiDepartment: {
    personId: "journey-0057-multidept",
    firstName: "Mona",
    lastName: "Fjellheim",
    email: "mona.fjellheim@example.invalid",
    password: "mona-pass-2026-long",
  },
  endedMember: {
    personId: "journey-0057-ended",
    firstName: "Gunnar",
    lastName: "Avsluttet",
    email: "gunnar.avsluttet@example.invalid",
    password: "gunnar-pass-2026-long",
  },
  plainMember: {
    personId: "journey-0057-member",
    firstName: "Pia",
    lastName: "Medlem",
    email: "pia.medlem@example.invalid",
    password: "pia-pass-2026-longg",
  },
  leader: {
    personId: "journey-0057-leader",
    firstName: "Leif",
    lastName: "Ledersen",
    email: "leif.ledersen@example.invalid",
    password: "leif-pass-2026-long",
  },
  osloOnly: {
    personId: "journey-0057-oslo",
    firstName: "Nora",
    lastName: "Oslobergen",
    email: "nora.oslobergen@example.invalid",
    password: "nora-pass-2026-long",
  },
};

const trondheimDepartmentId = "department-journey-0057-trondheim";
const osloDepartmentId = "department-journey-0057-oslo";
const trondheimItTeamId = "team-journey-0057-trondheim-it";
const trondheimLeaderTeamId = "team-journey-0057-trondheim-leder";
const osloItTeamId = "team-journey-0057-oslo-it";

// Membership/grant windows bracket the journey clock (2026). The ended
// membership ends strictly before now so the person lands under Inaktive.
const activeStartAt = "2026-01-01T00:00:00.000Z";
const endedStartAt = "2024-06-01T00:00:00.000Z";
const endedEndAt = "2026-08-01T00:00:00.000Z";

const seedSql = `
BEGIN;

INSERT INTO organization_departments (
  department_id, name, short_name, email, city, active, revision
)
VALUES
  ('${trondheimDepartmentId}', 'Trondheim', 'TRD',
   'trondheim.journey@example.invalid', 'Trondheim', TRUE, 0),
  ('${osloDepartmentId}', 'Oslo', 'OSL',
   'oslo.journey@example.invalid', 'Oslo', TRUE, 0)
ON CONFLICT (department_id) DO NOTHING;

INSERT INTO organization_teams (team_id, department_id, name, active, revision)
VALUES
  ('${trondheimItTeamId}', '${trondheimDepartmentId}', 'IT Trondheim', TRUE, 0),
  ('${trondheimLeaderTeamId}', '${trondheimDepartmentId}', 'Ledergruppe Trondheim', TRUE, 0),
  ('${osloItTeamId}', '${osloDepartmentId}', 'IT Oslo', TRUE, 0)
ON CONFLICT (team_id) DO NOTHING;

INSERT INTO person_contact_profiles (person_id, email, phone, revision)
VALUES
  ('${journeyPersons.admin.personId}',
   '${journeyPersons.admin.email}', '+47 900 00 057', 0),
  ('${journeyPersons.multiDepartment.personId}',
   '${journeyPersons.multiDepartment.email}', '+47 900 01 057', 0),
  ('${journeyPersons.endedMember.personId}',
   '${journeyPersons.endedMember.email}', '+47 900 02 057', 0),
  ('${journeyPersons.plainMember.personId}',
   '${journeyPersons.plainMember.email}', '+47 900 03 057', 0),
  ('${journeyPersons.leader.personId}',
   '${journeyPersons.leader.email}', '+47 900 04 057', 0),
  ('${journeyPersons.osloOnly.personId}',
   '${journeyPersons.osloOnly.email}', '+47 900 05 057', 0)
ON CONFLICT (person_id) DO NOTHING;

-- Active global administrator grant for the directory caller.
INSERT INTO organization_global_administrator_grants (
  grant_id, person_id, start_at, end_at, revision
)
VALUES (
  'grant-journey-0057-admin', '${journeyPersons.admin.personId}',
  '${activeStartAt}', NULL, 0
)
ON CONFLICT (grant_id) DO NOTHING;

INSERT INTO organization_memberships (
  membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
  position_id, is_team_leader, is_suspended, revision
)
VALUES
  -- Multi-department person: active memberships in TWO departments.
  ('membership-journey-0057-multidept-trondheim',
   '${journeyPersons.multiDepartment.personId}', '${trondheimItTeamId}',
   NULL, '${activeStartAt}', NULL, 'member', FALSE, FALSE, 0),
  ('membership-journey-0057-multidept-oslo',
   '${journeyPersons.multiDepartment.personId}', '${osloItTeamId}',
   NULL, '${activeStartAt}', NULL, 'member', FALSE, FALSE, 0),
  -- Ended membership: end_at strictly before now -> Inaktive Brukere.
  ('membership-journey-0057-ended',
   '${journeyPersons.endedMember.personId}', '${trondheimItTeamId}',
   NULL, '${endedStartAt}', '${endedEndAt}', 'member', FALSE, FALSE, 0),
  -- Plain member: active membership without leadership -> typed denial.
  ('membership-journey-0057-member',
   '${journeyPersons.plainMember.personId}', '${trondheimItTeamId}',
   NULL, '${activeStartAt}', NULL, 'member', FALSE, FALSE, 0),
  -- Department leader: active leadership in exactly ONE department.
  ('membership-journey-0057-leader',
   '${journeyPersons.leader.personId}', '${trondheimLeaderTeamId}',
   NULL, '${activeStartAt}', NULL, 'leader', TRUE, FALSE, 0),
  -- Oslo-only member the leader's scope must exclude.
  ('membership-journey-0057-oslo',
   '${journeyPersons.osloOnly.personId}', '${osloItTeamId}',
   NULL, '${activeStartAt}', NULL, 'member', FALSE, FALSE, 0)
ON CONFLICT (membership_id) DO NOTHING;

COMMIT;
`;

const assert = (condition, message) => {
  if (!condition) throw new Error(`journey seed assertion failed: ${message}`);
};

const runIdentitySeed = () => {
  const result = spawnSync("bun", ["run", "identity:seed"], {
    cwd: databaseRoot,
    env: {
      ...process.env,
      IDENTITY_SEED_PG_URL: postgresUrl,
      IDENTITY_SEED_PERSONS: JSON.stringify(Object.values(journeyPersons)),
    },
    encoding: "utf8",
  });
  assert(result.status === 0, `identity:seed failed:\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(`identity:seed: ${result.stdout.trim().split("\n").pop()}\n`);
};

async function main() {
  runIdentitySeed();

  const observer = new Pool({
    connectionString: postgresUrl,
    options: "-c search_path=public",
    max: 1,
    application_name: "native-users-journey-seed",
  });

  try {
    await observer.query(seedSql);

    // Read back every fact the journey depends on (asserted provisioning).
    const checks = await observer.query(`
      SELECT
        (SELECT count(*) FROM organization_departments d WHERE d.active) AS departments,
        (SELECT count(*) FROM organization_teams t WHERE t.active) AS teams,
        (SELECT count(*) FROM person_contact_profiles c) AS contacts,
        (SELECT count(*) FROM organization_global_administrator_grants g
          WHERE g.person_id = '${journeyPersons.admin.personId}'
          AND g.start_at <= now() AND (g.end_at IS NULL OR now() < g.end_at)) AS active_grants,
        (SELECT count(*) FROM organization_memberships m
          WHERE m.person_id = '${journeyPersons.multiDepartment.personId}'
          AND m.start_at <= now() AND (m.end_at IS NULL OR now() < m.end_at)
          AND NOT m.is_suspended) AS multidept_memberships,
        (SELECT count(DISTINCT team.department_id) FROM organization_memberships m
          JOIN organization_teams team ON team.team_id = m.team_id
          WHERE m.person_id = '${journeyPersons.multiDepartment.personId}'
          AND m.start_at <= now() AND (m.end_at IS NULL OR now() < m.end_at)
          AND NOT m.is_suspended) AS multidept_departments,
        (SELECT count(*) FROM organization_memberships m
          WHERE m.person_id = '${journeyPersons.endedMember.personId}'
          AND m.end_at IS NOT NULL AND m.end_at < now()) AS ended_memberships,
        (SELECT count(*) FROM organization_memberships m
          WHERE m.person_id = '${journeyPersons.plainMember.personId}'
          AND m.start_at <= now() AND (m.end_at IS NULL OR now() < m.end_at)
          AND NOT m.is_suspended AND NOT m.is_team_leader) AS plain_member_memberships,
        (SELECT count(*) FROM organization_memberships m
          WHERE m.person_id = '${journeyPersons.leader.personId}'
          AND m.is_team_leader AND NOT m.is_suspended
          AND m.start_at <= now() AND (m.end_at IS NULL OR now() < m.end_at))
          AS leader_memberships,
        (SELECT count(*) FROM organization_memberships m
          JOIN organization_teams team ON team.team_id = m.team_id
          WHERE team.department_id = '${trondheimDepartmentId}'
          AND m.person_id <> '${journeyPersons.leader.personId}'
          AND m.start_at <= now() AND (m.end_at IS NULL OR now() < m.end_at)
          AND NOT m.is_suspended) AS other_trondheim_members,
        (SELECT count(*) FROM organization_memberships m
          JOIN organization_teams team ON team.team_id = m.team_id
          WHERE team.department_id = '${osloDepartmentId}'
          AND m.start_at <= now() AND (m.end_at IS NULL OR now() < m.end_at)
          AND NOT m.is_suspended) AS oslo_active_members,
        (SELECT count(*) FROM auth."user" u WHERE u.id IN (
          '${journeyPersons.admin.personId}',
          '${journeyPersons.multiDepartment.personId}',
          '${journeyPersons.endedMember.personId}',
          '${journeyPersons.plainMember.personId}',
          '${journeyPersons.leader.personId}',
          '${journeyPersons.osloOnly.personId}')) AS users
    `);
    const counts = checks.rows[0];
    assert(Number(counts.departments) >= 2, "two active departments");
    assert(Number(counts.teams) >= 3, "three live teams");
    assert(Number(counts.contacts) === 6, "six contact profiles");
    assert(Number(counts.active_grants) === 1, "one active global administrator grant");
    assert(Number(counts.multidept_memberships) === 2, "two active memberships for Mona");
    assert(Number(counts.multidept_departments) === 2, "Mona spans two departments");
    assert(Number(counts.ended_memberships) === 1, "one ended membership strictly before now");
    assert(
      Number(counts.plain_member_memberships) === 1,
      "one active non-leader membership for Pia",
    );
    assert(Number(counts.leader_memberships) === 1, "exactly one active leader membership");
    assert(Number(counts.other_trondheim_members) >= 1, "leader department holds another member");
    assert(Number(counts.oslo_active_members) >= 1, "an Oslo-only member exists to exclude");
    assert(Number(counts.users) === 6, "six login-capable auth users");

    process.stdout.write(
      `${JSON.stringify({ seeded: "native-users-journey-0057", counts }, null, 2)}\n`,
    );
  } finally {
    await observer.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
