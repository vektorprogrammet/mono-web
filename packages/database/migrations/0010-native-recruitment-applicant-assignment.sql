CREATE TABLE IF NOT EXISTS person_profiles (
  person_id text PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT person_profiles_id_nonempty CHECK (btrim(person_id) <> ''),
  CONSTRAINT person_profiles_first_name_nonempty CHECK (btrim(first_name) <> ''),
  CONSTRAINT person_profiles_last_name_nonempty CHECK (btrim(last_name) <> ''),
  CONSTRAINT person_profiles_first_name_length CHECK (char_length(first_name) BETWEEN 1 AND 100),
  CONSTRAINT person_profiles_last_name_length CHECK (char_length(last_name) BETWEEN 1 AND 100),
  CONSTRAINT person_profiles_revision_nonnegative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS recruitment_interview_schemas (
  interview_schema_id text PRIMARY KEY,
  name text NOT NULL,
  question_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT TRUE,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT recruitment_interview_schemas_id_nonempty CHECK (btrim(interview_schema_id) <> ''),
  CONSTRAINT recruitment_interview_schemas_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT recruitment_interview_schemas_question_count_nonnegative CHECK (question_count >= 0),
  CONSTRAINT recruitment_interview_schemas_revision_nonnegative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS recruitment_interviews (
  interview_id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES admission_applications(application_id),
  department_id text NOT NULL REFERENCES admission_period_departments(department_id),
  interviewer_person_id text NOT NULL REFERENCES person_profiles(person_id),
  interview_schema_id text NOT NULL REFERENCES recruitment_interview_schemas(interview_schema_id),
  assigned_by_person_id text NOT NULL,
  assigned_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'NoContact',
  scheduled_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT recruitment_interviews_id_nonempty CHECK (btrim(interview_id) <> ''),
  CONSTRAINT recruitment_interviews_state_schedule_check CHECK (
    state = 'NoContact' AND scheduled_at IS NULL
  ),
  CONSTRAINT recruitment_interviews_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT recruitment_interviews_application_unique UNIQUE (application_id)
);

CREATE TABLE IF NOT EXISTS recruitment_assignment_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL,
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  application_id text NOT NULL REFERENCES admission_applications(application_id),
  interview_id text NOT NULL REFERENCES recruitment_interviews(interview_id),
  committed_at timestamptz NOT NULL,
  CONSTRAINT recruitment_assignment_receipts_id_nonempty CHECK (btrim(command_id) <> ''),
  CONSTRAINT recruitment_assignment_receipts_digest CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT recruitment_assignment_receipts_interview_unique UNIQUE (interview_id)
);

CREATE TABLE IF NOT EXISTS recruitment_assignment_audit (
  command_id text PRIMARY KEY REFERENCES recruitment_assignment_command_receipts(command_id),
  interview_id text NOT NULL REFERENCES recruitment_interviews(interview_id),
  application_id text NOT NULL REFERENCES admission_applications(application_id),
  department_id text NOT NULL REFERENCES admission_period_departments(department_id),
  actor_person_id text NOT NULL,
  action text NOT NULL,
  interview_revision integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT recruitment_assignment_audit_action CHECK (action = 'ApplicantAssigned'),
  CONSTRAINT recruitment_assignment_audit_revision_nonnegative CHECK (interview_revision >= 0),
  CONSTRAINT recruitment_assignment_audit_interview_unique UNIQUE (interview_id)
);

CREATE INDEX IF NOT EXISTS recruitment_interviews_department_order
  ON recruitment_interviews (department_id, application_id);
CREATE INDEX IF NOT EXISTS recruitment_assignment_receipts_application
  ON recruitment_assignment_command_receipts (application_id);
CREATE INDEX IF NOT EXISTS recruitment_assignment_audit_application
  ON recruitment_assignment_audit (application_id);
