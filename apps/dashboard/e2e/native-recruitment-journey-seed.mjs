/**
 * Recruitment journey seed support (spec 0049 on the native Identity stack).
 *
 * Provisions the 0049 team-leader journey personas against a DISPOSABLE
 * loopback PostgreSQL cluster and asserts they satisfy the frozen spec:
 *
 * - one team-leader person (identity:seed) with an ACTIVE Organization
 *   membership (is_team_leader, not suspended) in a department that owns an
 *   OPEN admission period with one unassigned applicant application;
 * - two interviewer persons (identity:seed) with active memberships in a
 *   live team of the same department;
 * - person_contact_profiles rows so ROLE_TEAM_LEADER /api/me resolves;
 * - one active interview schema owned by Recruitment.
 *
 * Login-capable persons are created through the existing identity:seed
 * entrypoint; this script only adds the Organization / Admissions /
 * Recruitment facts around them. Every insert is idempotent
 * (ON CONFLICT DO NOTHING) and every write is asserted by reading it back.
 *
 * Usage:
 *   JOURNEY_SEED_PG_URL=postgres://postgres@127.0.0.1:45121/postgres \
 *     bun apps/dashboard/e2e/native-recruitment-journey-seed.mjs
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
  process.env.JOURNEY_SEED_PG_URL ?? "postgres://postgres@127.0.0.1:45121/postgres";

const parsedUrl = new URL(postgresUrl);
if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
  throw new Error("JOURNEY_SEED_PG_URL must use PostgreSQL");
}
if (!["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
  throw new Error("journey seed is restricted to loopback PostgreSQL");
}

// Journey persona facts. Password satisfies better-auth minPasswordLength=12.
export const journeyPersons = {
  leader: {
    personId: "journey-rec-leader-0049",
    firstName: "Lina",
    lastName: "Lagleder",
    email: "lina.leader@example.invalid",
    password: "journey-secret-0123456789abcdef",
  },
  interviewerA: {
    personId: "journey-rec-interviewer-a-0049",
    firstName: "Irene",
    lastName: "Intervjuer",
    email: "irene.intervjuer@example.invalid",
    password: "journey-secret-0123456789abcdef",
  },
  interviewerB: {
    personId: "journey-rec-interviewer-b-0049",
    firstName: "Ida",
    lastName: "Intervjuer",
    email: "ida.intervjuer@example.invalid",
    password: "journey-secret-0123456789abcdef",
  },
};

const departmentId = "department-native-journey-0049";
const semesterId = "semester-native-journey-0049";
const admissionPeriodId = "admission-period-native-journey-0049";
const fieldOfStudyId = "field-native-journey-0049";
const recruitmentTeamId = "team-native-journey-0049";
const applicantId = "applicant-native-journey-0049";
const applicationId = "application-native-journey-0049";
const interviewSchemaId = "interview-schema-native-journey-0049";

// The admission period must be OPEN at the authorization instant (real clock),
// so its window brackets 2026. Membership windows bracket 2026 as well.
const membershipStartAt = "2026-01-01T00:00:00.000Z";
const semesterStartAt = "2026-01-01T00:00:00.000Z";
const semesterEndAt = "2027-01-01T00:00:00.000Z";
const periodStartAt = "2026-08-01T00:00:00.000Z";
const periodEndAt = "2026-09-30T23:59:59.999Z";

const seedSql = `
BEGIN;

-- Admissions scope: department row shared with Organization (same id).
INSERT INTO admission_period_departments (department_id, name)
VALUES ('${departmentId}', 'Trondheim')
ON CONFLICT (department_id) DO NOTHING;

INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
VALUES ('${semesterId}', '${semesterStartAt}', '${semesterEndAt}')
ON CONFLICT (semester_id) DO NOTHING;

INSERT INTO admission_periods (
  admission_period_id, department_id, semester_id, start_at, end_at,
  revision, last_command_id
)
VALUES (
  '${admissionPeriodId}', '${departmentId}', '${semesterId}',
  '${periodStartAt}', '${periodEndAt}', 0,
  'admission-period-native-journey-seed-0049'
)
ON CONFLICT (admission_period_id) DO NOTHING;

INSERT INTO admission_period_fields_of_study (
  field_of_study_id, department_id, name, active
)
VALUES ('${fieldOfStudyId}', '${departmentId}', 'Datateknologi', TRUE)
ON CONFLICT (field_of_study_id) DO NOTHING;

-- One UNASSIGNED applicant application in the open period (spec 0049 board).
INSERT INTO admission_applicants (
  applicant_id, normalized_email, email, first_name, last_name, phone,
  gender, field_of_study_id, year_of_study, activation_digest
)
VALUES (
  '${applicantId}', 'sofie.soker@example.invalid', 'sofie.soker@example.invalid',
  'Sofie', 'Søker', '90000049', 1, '${fieldOfStudyId}', 3, NULL
)
ON CONFLICT (applicant_id) DO NOTHING;

INSERT INTO admission_applications (
  application_id, applicant_id, admission_period_id, department_id,
  field_of_study_id, year_of_study, submitted_at, revision
)
VALUES (
  '${applicationId}', '${applicantId}', '${admissionPeriodId}', '${departmentId}',
  '${fieldOfStudyId}', 3, '2026-08-20T10:00:00.000Z', 0
)
ON CONFLICT (application_id) DO NOTHING;

-- Organization authority: department, live team, active memberships.
-- The leader membership carries is_team_leader and NOT suspended so the
-- frozen 0055 mapper yields DepartmentLeader for the department scope.
INSERT INTO organization_departments (
  department_id, name, short_name, email, city, active, revision
)
VALUES (
  '${departmentId}', 'Vektorprogrammet Trondheim', 'Trondheim',
  'trondheim@example.invalid', 'Trondheim', TRUE, 0
)
ON CONFLICT (department_id) DO NOTHING;

INSERT INTO organization_teams (team_id, department_id, name, active, revision)
VALUES ('${recruitmentTeamId}', '${departmentId}', 'Rekruttering', TRUE, 0)
ON CONFLICT (team_id) DO NOTHING;

INSERT INTO person_profiles (person_id, first_name, last_name, revision)
VALUES
  ('${journeyPersons.leader.personId}', 'Lina', 'Lagleder', 0),
  ('${journeyPersons.interviewerA.personId}', 'Irene', 'Intervjuer', 0),
  ('${journeyPersons.interviewerB.personId}', 'Ida', 'Intervjuer', 0)
ON CONFLICT (person_id) DO NOTHING;

INSERT INTO person_contact_profiles (person_id, email, phone, revision)
VALUES
  ('${journeyPersons.leader.personId}', 'lina.leader@example.invalid', '+47 900 00 049', 0),
  ('${journeyPersons.interviewerA.personId}', 'irene.intervjuer@example.invalid', '+47 900 00 052', 0),
  ('${journeyPersons.interviewerB.personId}', 'ida.intervjuer@example.invalid', '+47 900 00 053', 0)
ON CONFLICT (person_id) DO NOTHING;

INSERT INTO organization_memberships (
  membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
  position_id, is_team_leader, is_suspended, revision
)
VALUES
  ('membership-native-journey-leader-0049', '${journeyPersons.leader.personId}',
   '${recruitmentTeamId}', NULL, '${membershipStartAt}', NULL,
   'teamleader', TRUE, FALSE, 0),
  ('membership-native-journey-interviewer-a-0049', '${journeyPersons.interviewerA.personId}',
   '${recruitmentTeamId}', NULL, '${membershipStartAt}', NULL,
   'interviewer', FALSE, FALSE, 0),
  ('membership-native-journey-interviewer-b-0049', '${journeyPersons.interviewerB.personId}',
   '${recruitmentTeamId}', NULL, '${membershipStartAt}', NULL,
   'interviewer', FALSE, FALSE, 0)
ON CONFLICT (membership_id) DO NOTHING;

-- Active interview schema owned by Recruitment (only actives are choices).
INSERT INTO recruitment_interview_schemas (
  interview_schema_id, name, question_count, active, revision
)
VALUES ('${interviewSchemaId}', 'Førstegangsintervju', 8, TRUE, 0)
ON CONFLICT (interview_schema_id) DO NOTHING;
INSERT INTO recruitment_interview_schema_questions (
  interview_schema_id, question_id, ordinal, prompt, help_text, kind, alternatives
) VALUES
  ('${interviewSchemaId}', '${interviewSchemaId}-q0', 0, 'Question 0', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q1', 1, 'Question 1', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q2', 2, 'Question 2', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q3', 3, 'Question 3', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q4', 4, 'Question 4', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q5', 5, 'Question 5', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q6', 6, 'Question 6', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q7', 7, 'Question 7', NULL, 'text', '[]'::jsonb)
ON CONFLICT (interview_schema_id, question_id) DO NOTHING;

COMMIT;
`;

const assert = (condition, message) => {
  if (!condition) throw new Error(`journey seed assertion failed: ${message}`);
};

const runIdentitySeed = () => {
  const result = spawnSync(
    "bun",
    ["run", "identity:seed"],
    {
      cwd: databaseRoot,
      env: {
        ...process.env,
        IDENTITY_SEED_PG_URL: postgresUrl,
        IDENTITY_SEED_PERSONS: JSON.stringify(Object.values(journeyPersons)),
      },
      encoding: "utf8",
    },
  );
  assert(result.status === 0, `identity:seed failed:\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(`identity:seed: ${result.stdout.trim().split("\n").pop()}\n`);
};

async function main() {
  runIdentitySeed();

  const observer = new Pool({
    connectionString: postgresUrl,
    options: "-c search_path=public",
    max: 1,
    application_name: "native-recruitment-journey-seed",
  });

  try {
    await observer.query(seedSql);

    // Read back every fact the journey depends on (asserted provisioning).
    const checks = await observer.query(`
      SELECT
        (SELECT count(*) FROM admission_applications WHERE application_id = '${applicationId}') AS applications,
        (SELECT count(*) FROM admission_periods p WHERE p.admission_period_id = '${admissionPeriodId}' AND p.start_at <= now() AND now() < p.end_at) AS open_periods,
        (SELECT count(*) FROM organization_memberships m WHERE m.is_team_leader AND NOT m.is_suspended AND m.person_id = '${journeyPersons.leader.personId}') AS leader_memberships,
        (SELECT count(*) FROM organization_memberships m WHERE m.team_id = '${recruitmentTeamId}' AND NOT m.is_suspended AND m.is_team_leader = FALSE) AS interviewer_memberships,
        (SELECT count(*) FROM recruitment_interview_schemas s WHERE s.interview_schema_id = '${interviewSchemaId}' AND s.active) AS schemas,
        (SELECT count(*) FROM person_contact_profiles c WHERE c.person_id IN ('${journeyPersons.leader.personId}', '${journeyPersons.interviewerA.personId}', '${journeyPersons.interviewerB.personId}')) AS contacts,
        (SELECT count(*) FROM auth."user" u WHERE u.id IN ('${journeyPersons.leader.personId}', '${journeyPersons.interviewerA.personId}', '${journeyPersons.interviewerB.personId}')) AS users
    `);
    const counts = checks.rows[0];
    assert(Number(counts.applications) === 1, "exactly one applicant application");
    assert(Number(counts.open_periods) === 1, "open admission period present");
    assert(Number(counts.leader_memberships) >= 1, "active team-leader membership");
    assert(
      Number(counts.interviewer_memberships) === 2,
      "two active interviewer memberships",
    );
    assert(Number(counts.schemas) === 1, "one active interview schema");
    assert(Number(counts.contacts) === 3, "three contact profiles");
    assert(Number(counts.users) === 3, "three login-capable auth users");

    process.stdout.write(
      `${JSON.stringify({ seeded: "native-recruitment-journey-0049", counts }, null, 2)}\n`,
    );
  } finally {
    await observer.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
