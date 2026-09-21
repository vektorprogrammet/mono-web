-- 0039 replaces the disposable 0038 application proof shape.
-- Run after 0001-admission-period-authority.sql. Reference data is seeded by the
-- local runner: departments, semesters, periods, and active field-of-study rows.
-- Existing native application tables require an explicit, data-preserving
-- migration; this authority migration never destroys them implicitly.

ALTER TABLE admission_period_departments
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS admission_period_fields_of_study (
  field_of_study_id text PRIMARY KEY,
  department_id text NOT NULL REFERENCES admission_period_departments(department_id),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT TRUE,
  CONSTRAINT admission_period_fields_of_study_id_nonempty CHECK (field_of_study_id <> ''),
  CONSTRAINT admission_period_fields_of_study_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT admission_period_fields_of_study_department_pair_unique
    UNIQUE (field_of_study_id, department_id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM admission_applications)
    OR EXISTS (SELECT 1 FROM admission_application_command_receipts)
    OR to_regclass('admission_application_outbox') IS NOT NULL
    OR to_regclass('admission_application_audit') IS NOT NULL
    OR to_regclass('admission_applicants') IS NOT NULL
  THEN
    RAISE EXCEPTION
      'public applicant authority tables contain data or canonical schema; run an explicit data-preserving migration';
  END IF;
END
$$;

DROP TABLE admission_application_command_receipts;
DROP TABLE admission_applications;

CREATE TABLE admission_applicants (
  applicant_id text PRIMARY KEY,
  normalized_email text NOT NULL UNIQUE,
  email text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone text NOT NULL,
  gender integer NOT NULL,
  field_of_study_id text NOT NULL,
  year_of_study integer NOT NULL,
  activation_digest text NULL,
  CONSTRAINT admission_applicants_id_nonempty CHECK (applicant_id <> ''),
  CONSTRAINT admission_applicants_email_nonempty CHECK (btrim(email) <> ''),
  CONSTRAINT admission_applicants_normalized_email_nonempty CHECK (normalized_email <> ''),
  CONSTRAINT admission_applicants_first_name_length CHECK (char_length(first_name) BETWEEN 1 AND 100),
  CONSTRAINT admission_applicants_last_name_length CHECK (char_length(last_name) BETWEEN 1 AND 100),
  CONSTRAINT admission_applicants_phone_length CHECK (char_length(phone) BETWEEN 1 AND 32),
  CONSTRAINT admission_applicants_gender CHECK (gender IN (0, 1)),
  CONSTRAINT admission_applicants_year CHECK (year_of_study BETWEEN 1 AND 5),
  CONSTRAINT admission_applicants_activation_digest CHECK (
    activation_digest IS NULL OR activation_digest ~ '^[a-f0-9]{64}$'
  )
);

CREATE TABLE admission_applications (
  application_id text PRIMARY KEY,
  applicant_id text NOT NULL REFERENCES admission_applicants(applicant_id),
  admission_period_id text NOT NULL REFERENCES admission_periods(admission_period_id),
  department_id text NOT NULL REFERENCES admission_period_departments(department_id),
  field_of_study_id text NOT NULL,
  year_of_study integer NOT NULL,
  submitted_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT admission_applications_id_nonempty CHECK (application_id <> ''),
  CONSTRAINT admission_applications_year CHECK (year_of_study BETWEEN 1 AND 5),
  CONSTRAINT admission_applications_revision CHECK (revision = 0),
  CONSTRAINT admission_applications_field_scope
    FOREIGN KEY (field_of_study_id, department_id)
    REFERENCES admission_period_fields_of_study(field_of_study_id, department_id),
  CONSTRAINT admission_applications_applicant_period_unique
    UNIQUE (applicant_id, admission_period_id)
);

CREATE TABLE admission_application_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  application_id text NOT NULL REFERENCES admission_applications(application_id),
  committed_at timestamptz NOT NULL,
  CONSTRAINT admission_application_command_receipts_id_nonempty CHECK (command_id <> '')
);

CREATE TABLE admission_application_audit (
  command_id text PRIMARY KEY REFERENCES admission_application_command_receipts(command_id),
  application_id text NOT NULL REFERENCES admission_applications(application_id),
  applicant_id text NOT NULL REFERENCES admission_applicants(applicant_id),
  action text NOT NULL CHECK (action = 'PublicApplicationSubmitted'),
  application_revision integer NOT NULL CHECK (application_revision = 0),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT admission_application_audit_applicant_nonempty CHECK (applicant_id <> '')
);

CREATE TABLE admission_application_outbox (
  effect_id text PRIMARY KEY,
  effect_type text NOT NULL CHECK (
    effect_type IN (
      'SendApplicantActivationOrConfirmation',
      'CreateAdmissionSubscription',
      'WriteApplicationAudit'
    )
  ),
  application_id text NOT NULL REFERENCES admission_applications(application_id),
  applicant_id text NOT NULL REFERENCES admission_applicants(applicant_id),
  command_id text NOT NULL REFERENCES admission_application_command_receipts(command_id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 2),
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Processing', 'Delivered', 'Failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_id text NULL,
  claimed_at timestamptz NULL,
  last_failure_tag text NULL,
  UNIQUE (command_id, ordinal),
  CONSTRAINT admission_application_outbox_claim_check CHECK (
    (status = 'Processing' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'Processing' AND claim_id IS NULL AND claimed_at IS NULL)
  )
);

CREATE UNIQUE INDEX admission_application_outbox_active_claim_unique
  ON admission_application_outbox (claim_id)
  WHERE claim_id IS NOT NULL;
CREATE INDEX admission_application_outbox_pending_order
  ON admission_application_outbox (status, command_id, ordinal);
CREATE INDEX admission_applicants_normalized_email_lock
  ON admission_applicants (normalized_email);
