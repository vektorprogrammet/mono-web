CREATE TABLE IF NOT EXISTS admission_period_departments (
  department_id text PRIMARY KEY,
  CONSTRAINT admission_period_departments_id_nonempty CHECK (department_id <> '')
);

CREATE TABLE IF NOT EXISTS admission_period_semesters (
  semester_id text PRIMARY KEY,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  CONSTRAINT admission_period_semesters_id_nonempty CHECK (semester_id <> ''),
  CONSTRAINT admission_period_semesters_ordered CHECK (start_at < end_at)
);

CREATE TABLE IF NOT EXISTS admission_periods (
  admission_period_id text PRIMARY KEY,
  department_id text NOT NULL REFERENCES admission_period_departments(department_id),
  semester_id text NOT NULL REFERENCES admission_period_semesters(semester_id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  last_command_id text NOT NULL,
  CONSTRAINT admission_periods_id_nonempty CHECK (admission_period_id <> ''),
  CONSTRAINT admission_periods_ordered CHECK (start_at < end_at),
  CONSTRAINT admission_periods_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT admission_periods_command_nonempty CHECK (last_command_id <> ''),
  CONSTRAINT admission_periods_department_semester_unique UNIQUE (department_id, semester_id)
);

CREATE TABLE IF NOT EXISTS admission_period_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  admission_period_id text NOT NULL REFERENCES admission_periods(admission_period_id),
  committed_at timestamptz NOT NULL,
  CONSTRAINT admission_period_command_receipts_id_nonempty CHECK (command_id <> '')
);

CREATE TABLE IF NOT EXISTS admission_period_audit (
  command_id text PRIMARY KEY REFERENCES admission_period_command_receipts(command_id),
  admission_period_id text NOT NULL REFERENCES admission_periods(admission_period_id),
  actor_person_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('AdmissionPeriodCreated', 'AdmissionPeriodRevised')),
  admission_period_revision integer NOT NULL CHECK (admission_period_revision >= 0),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT admission_period_audit_actor_nonempty CHECK (actor_person_id <> '')
);

CREATE TABLE IF NOT EXISTS admission_period_outbox (
  effect_id text PRIMARY KEY,
  effect_type text NOT NULL CHECK (effect_type = 'PublishAdmissionPeriodChanged'),
  admission_period_id text NOT NULL REFERENCES admission_periods(admission_period_id),
  command_id text NOT NULL REFERENCES admission_period_command_receipts(command_id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Processing', 'Delivered', 'Failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_id text NULL,
  claimed_at timestamptz NULL,
  last_failure_tag text NULL,
  UNIQUE (command_id, ordinal),
  CONSTRAINT admission_period_outbox_claim_check CHECK (
    (status = 'Processing' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'Processing' AND claim_id IS NULL AND claimed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS admission_period_outbox_active_claim_unique
  ON admission_period_outbox (claim_id)
  WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS admission_period_outbox_pending_order
  ON admission_period_outbox (status, command_id, ordinal);

CREATE TABLE IF NOT EXISTS admission_applications (
  application_id text PRIMARY KEY,
  applicant_id text NOT NULL,
  admission_period_id text NOT NULL REFERENCES admission_periods(admission_period_id),
  created_at timestamptz NOT NULL,
  CONSTRAINT admission_applications_id_nonempty CHECK (application_id <> ''),
  CONSTRAINT admission_applications_applicant_nonempty CHECK (applicant_id <> '')
);

CREATE TABLE IF NOT EXISTS admission_application_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  command_json jsonb NOT NULL,
  application_json jsonb NOT NULL,
  committed_at timestamptz NOT NULL,
  CONSTRAINT admission_application_command_receipts_id_nonempty CHECK (command_id <> '')
);
