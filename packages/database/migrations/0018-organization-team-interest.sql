CREATE TABLE IF NOT EXISTS organization_team_interest_registrations (
  registration_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submitter_name text NOT NULL,
  submitter_email text NOT NULL,
  team_id text NOT NULL REFERENCES organization_teams(team_id) ON DELETE RESTRICT,
  department_id text NOT NULL
    REFERENCES organization_departments(department_id) ON DELETE RESTRICT,
  semester_id text NULL,
  submitted_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT organization_team_interest_registrations_name_nonempty CHECK (
    btrim(submitter_name) <> ''
  ),
  CONSTRAINT organization_team_interest_registrations_name_length CHECK (
    char_length(submitter_name) <= 255
  ),
  CONSTRAINT organization_team_interest_registrations_email_nonempty CHECK (
    btrim(submitter_email) <> ''
  ),
  CONSTRAINT organization_team_interest_registrations_email_length CHECK (
    char_length(submitter_email) <= 255
  ),
  CONSTRAINT organization_team_interest_registrations_email_shape CHECK (
    submitter_email !~ '[^!-~]' AND submitter_email ~ '^[^@]+@[^@]+$'
  ),
  CONSTRAINT organization_team_interest_registrations_semester_id_nonempty CHECK (
    semester_id IS NULL OR btrim(semester_id) <> ''
  ),
  CONSTRAINT organization_team_interest_registrations_revision_nonnegative CHECK (
    revision >= 0
  )
);

CREATE INDEX IF NOT EXISTS organization_team_interest_registrations_scope_order
  ON organization_team_interest_registrations (department_id, semester_id, registration_id);
CREATE INDEX IF NOT EXISTS organization_team_interest_registrations_team_order
  ON organization_team_interest_registrations (team_id, registration_id);
