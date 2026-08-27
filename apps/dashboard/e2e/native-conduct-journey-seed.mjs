import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const databaseRoot = join(repositoryRoot, "packages", "database");
const require = createRequire(join(repositoryRoot, "packages/database/package.json"));
const { Pool } = require("pg");

export const persons = {
  leader: {
    personId: "journey-conduct-leader-0063",
    firstName: "Lina",
    lastName: "Lagleder",
    email: "lina.conduct@example.invalid",
    password: "journey-conduct-secret-0123456789",
  },
};

const departmentId = "department-native-conduct-0063";
const teamId = "team-native-conduct-0063";
const applicantA = "applicant-native-conduct-a-0063";
const applicantB = "applicant-native-conduct-b-0063";
const applicationA = "application-native-conduct-a-0063";
const applicationB = "application-native-conduct-b-0063";
const periodId = "admission-period-native-conduct-0063";
const semesterId = "semester-native-conduct-0063";
const fieldId = "field-native-conduct-0063";
const schemaId = "interview-schema-native-conduct-0063";
const interviewA = "interview-native-conduct-a-0063";
const interviewB = "interview-native-conduct-b-0063";
const invitationA = "invitation-native-conduct-a-0063";
const invitationB = "invitation-native-conduct-b-0063";
const scheduleA = "2031-09-20T13:30:00.000Z";
const scheduleB = "2031-09-21T13:30:00.000Z";
const questions = [
  ["q0", 0, "Fortell kort om motivasjonen din.", null, "text", []],
  [
    "q1",
    1,
    "Hvilket arbeidsområde interesserer deg mest?",
    "Velg ett område.",
    "list",
    ["Produkt", "Teknologi", "Organisasjon"],
  ],
  ["q2", 2, "Hvordan foretrekker du å lære?", null, "radio", ["Praksis", "Samtale", "Lesing"]],
  [
    "q3",
    3,
    "Hvilke styrker tar du med deg?",
    "Velg minst ett alternativ.",
    "check",
    ["Samarbeid", "Struktur", "Nysgjerrighet"],
  ],
];

const sql = `
BEGIN;
INSERT INTO admission_period_departments (department_id, name) VALUES ('${departmentId}', 'Trondheim') ON CONFLICT (department_id) DO NOTHING;
INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES ('${semesterId}', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z') ON CONFLICT (semester_id) DO NOTHING;
INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, revision, last_command_id)
VALUES ('${periodId}', '${departmentId}', '${semesterId}', '2026-08-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z', 0, 'admission-period-native-conduct-seed-0063')
ON CONFLICT (admission_period_id) DO NOTHING;
INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name, active)
VALUES ('${fieldId}', '${departmentId}', 'Datateknologi', TRUE) ON CONFLICT (field_of_study_id) DO NOTHING;
INSERT INTO admission_applicants (applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id, year_of_study, activation_digest)
VALUES
 ('${applicantA}', 'sofie.conduct@example.invalid', 'sofie.conduct@example.invalid', 'Sofie', 'Gjennomfører', '90000063', 1, '${fieldId}', 3, NULL),
 ('${applicantB}', 'olav.conduct@example.invalid', 'olav.conduct@example.invalid', 'Olav', 'Konflikt', '90000064', 1, '${fieldId}', 2, NULL)
ON CONFLICT (applicant_id) DO NOTHING;
INSERT INTO admission_applications (application_id, applicant_id, admission_period_id, department_id, field_of_study_id, year_of_study, submitted_at, revision)
VALUES
 ('${applicationA}', '${applicantA}', '${periodId}', '${departmentId}', '${fieldId}', 3, '2026-08-20T10:00:00.000Z', 0),
 ('${applicationB}', '${applicantB}', '${periodId}', '${departmentId}', '${fieldId}', 2, '2026-08-20T10:01:00.000Z', 0)
ON CONFLICT (application_id) DO NOTHING;
INSERT INTO organization_departments (department_id, name, short_name, email, city, active, revision)
VALUES ('${departmentId}', 'Vektorprogrammet Trondheim', 'Trondheim', 'trondheim.conduct@example.invalid', 'Trondheim', TRUE, 0)
ON CONFLICT (department_id) DO NOTHING;
INSERT INTO organization_teams (team_id, department_id, name, active, revision)
VALUES ('${teamId}', '${departmentId}', 'Rekruttering', TRUE, 0) ON CONFLICT (team_id) DO NOTHING;
INSERT INTO person_contact_profiles (person_id, email, phone, revision)
VALUES ('${persons.leader.personId}', '${persons.leader.email}', '+47 900 00 063', 0) ON CONFLICT (person_id) DO NOTHING;
INSERT INTO organization_memberships (membership_id, person_id, team_id, deleted_team_name, start_at, end_at, position_id, is_team_leader, is_suspended, revision)
VALUES ('membership-native-conduct-leader-0063', '${persons.leader.personId}', '${teamId}', NULL, '2026-01-01T00:00:00.000Z', NULL, 'teamleader', TRUE, FALSE, 0)
ON CONFLICT (membership_id) DO NOTHING;
INSERT INTO recruitment_interview_schemas (interview_schema_id, name, question_count, active, revision)
VALUES ('${schemaId}', 'Førstegangsintervju 0063', ${questions.length}, TRUE, 0) ON CONFLICT (interview_schema_id) DO NOTHING;
INSERT INTO auth.recruitment_interview_schema_questions (interview_schema_id, question_id, ordinal, prompt, help_text, kind, alternatives)
VALUES
${questions.map(([id, ordinal, prompt, help, kind, alternatives]) => ` ('${schemaId}', '${schemaId}-${id}', ${ordinal}, '${prompt}', ${help === null ? "NULL" : `'${help}'`}, '${kind}', '${JSON.stringify(alternatives)}'::jsonb)`).join(",\n")}
ON CONFLICT (interview_schema_id, question_id) DO NOTHING;
INSERT INTO recruitment_interviews (interview_id, application_id, department_id, interviewer_person_id, interview_schema_id, assigned_by_person_id, assigned_at, revision)
VALUES
 ('${interviewA}', '${applicationA}', '${departmentId}', '${persons.leader.personId}', '${schemaId}', '${persons.leader.personId}', '2031-09-12T09:00:00.000Z', 1),
 ('${interviewB}', '${applicationB}', '${departmentId}', '${persons.leader.personId}', '${schemaId}', '${persons.leader.personId}', '2031-09-12T09:01:00.000Z', 1)
ON CONFLICT (interview_id) DO NOTHING;
INSERT INTO recruitment_interview_schedules (interview_id, scheduled_at, room, campus, map_link, message, scheduled_by_person_id, committed_at, schedule_revision)
VALUES
 ('${interviewA}', '${scheduleA}', 'K-0063A', 'Gløshaugen', 'https://maps.example.invalid/conduct-0063-a', 'Velkommen til intervjuet.', '${persons.leader.personId}', '2031-09-12T09:10:00.000Z', 1),
 ('${interviewB}', '${scheduleB}', 'K-0063B', 'Gløshaugen', 'https://maps.example.invalid/conduct-0063-b', 'Velkommen til intervjuet.', '${persons.leader.personId}', '2031-09-12T09:11:00.000Z', 1)
ON CONFLICT (interview_id) DO NOTHING;
INSERT INTO recruitment_invitations (invitation_id, interview_id, schedule_revision, capability_sha256, response_state, created_at, response_message, responded_at, response_revision, superseded_at)
VALUES
 ('${invitationA}', '${interviewA}', 1, repeat('a', 64), 'Accepted', '2031-09-12T09:10:00.000Z', NULL, '2031-09-13T10:00:00.000Z', 1, NULL),
 ('${invitationB}', '${interviewB}', 1, repeat('b', 64), 'Accepted', '2031-09-12T09:11:00.000Z', NULL, '2031-09-13T10:01:00.000Z', 1, NULL)
ON CONFLICT (invitation_id) DO NOTHING;
INSERT INTO recruitment_invitation_response_audit (invitation_id, interview_id, schedule_revision, response_revision, response_state, response_message, responded_at)
VALUES
 ('${invitationA}', '${interviewA}', 1, 1, 'Accepted', NULL, '2031-09-13T10:00:00.000Z'),
 ('${invitationB}', '${interviewB}', 1, 1, 'Accepted', NULL, '2031-09-13T10:01:00.000Z')
ON CONFLICT (invitation_id) DO NOTHING;
INSERT INTO auth.recruitment_interview_question_snapshots (interview_id, question_id, ordinal, prompt, help_text, kind, alternatives)
SELECT i.interview_id, q.question_id, q.ordinal, q.prompt, q.help_text, q.kind, q.alternatives
FROM (VALUES ('${interviewA}'), ('${interviewB}')) AS i(interview_id)
CROSS JOIN auth.recruitment_interview_schema_questions q
WHERE q.interview_schema_id = '${schemaId}'
ON CONFLICT (interview_id, question_id) DO NOTHING;
COMMIT;
`;

const postgresUrl =
  process.env.JOURNEY_SEED_PG_URL ?? "postgres://postgres@127.0.0.1:45121/postgres";
const parsed = new URL(postgresUrl);
if (
  !["postgres:", "postgresql:"].includes(parsed.protocol) ||
  !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
)
  throw new Error("conduct seed requires loopback PostgreSQL");
const identity = spawnSync("bun", ["run", "identity:seed"], {
  cwd: databaseRoot,
  env: {
    ...process.env,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify(Object.values(persons)),
  },
  encoding: "utf8",
});
if (identity.status !== 0)
  throw new Error(`identity:seed failed:\n${identity.stdout}\n${identity.stderr}`);
const pool = new Pool({
  connectionString: postgresUrl,
  options: "-c search_path=public",
  max: 1,
  application_name: "native-conduct-journey-seed",
});
try {
  await pool.query(sql);
  const result = await pool.query(
    `SELECT (SELECT count(*) FROM recruitment_interviews WHERE interview_id IN ('${interviewA}', '${interviewB}')) AS interviews, (SELECT count(*) FROM recruitment_interview_schedules WHERE interview_id IN ('${interviewA}', '${interviewB}')) AS schedules, (SELECT count(*) FROM recruitment_invitations WHERE interview_id IN ('${interviewA}', '${interviewB}') AND response_state = 'Accepted') AS accepted, (SELECT count(*) FROM auth.recruitment_interview_question_snapshots WHERE interview_id IN ('${interviewA}', '${interviewB}')) AS snapshots`,
  );
  const row = result.rows[0];
  if (
    Number(row.interviews) !== 2 ||
    Number(row.schedules) !== 2 ||
    Number(row.accepted) !== 2 ||
    Number(row.snapshots) !== 8
  )
    throw new Error(`conduct seed assertions failed: ${JSON.stringify(row)}`);
  process.stdout.write(
    `${JSON.stringify({ seeded: "native-recruitment-conduct-0063", counts: row })}\n`,
  );
} finally {
  await pool.end();
}
