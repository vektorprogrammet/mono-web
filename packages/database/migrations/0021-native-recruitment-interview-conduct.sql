CREATE TABLE IF NOT EXISTS recruitment_interview_schema_questions (
  interview_schema_id text NOT NULL REFERENCES recruitment_interview_schemas(interview_schema_id),
  question_id text NOT NULL,
  ordinal integer NOT NULL,
  prompt text NOT NULL,
  help_text text NULL,
  kind text NOT NULL,
  alternatives jsonb NOT NULL,
  CONSTRAINT recruitment_interview_schema_questions_pk PRIMARY KEY (interview_schema_id, question_id),
  CONSTRAINT recruitment_interview_schema_questions_ordinal_unique UNIQUE (interview_schema_id, ordinal),
  CONSTRAINT recruitment_interview_schema_questions_id_nonempty CHECK (btrim(question_id) <> ''),
  CONSTRAINT recruitment_interview_schema_questions_ordinal_nonnegative CHECK (ordinal >= 0),
  CONSTRAINT recruitment_interview_schema_questions_prompt_valid CHECK (
    btrim(prompt) <> '' AND prompt = btrim(prompt) AND char_length(prompt) <= 5000
  ),
  CONSTRAINT recruitment_interview_schema_questions_help_text_length CHECK (
    help_text IS NULL OR char_length(help_text) <= 5000
  ),
  CONSTRAINT recruitment_interview_schema_questions_kind_valid CHECK (
    kind IN ('text', 'list', 'radio', 'check')
  ),
  CONSTRAINT recruitment_interview_schema_questions_alternatives_array CHECK (
    jsonb_typeof(alternatives) = 'array'
  ),
  CONSTRAINT recruitment_interview_schema_questions_kind_alternatives CHECK (
    (kind = 'text' AND jsonb_array_length(alternatives) = 0)
    OR (kind IN ('list', 'radio', 'check') AND jsonb_array_length(alternatives) > 0)
  )
);

CREATE TABLE IF NOT EXISTS recruitment_interview_question_snapshots (
  interview_id text NOT NULL REFERENCES recruitment_interviews(interview_id),
  question_id text NOT NULL,
  ordinal integer NOT NULL,
  prompt text NOT NULL,
  help_text text NULL,
  kind text NOT NULL,
  alternatives jsonb NOT NULL,
  CONSTRAINT recruitment_interview_question_snapshots_pk PRIMARY KEY (interview_id, question_id),
  CONSTRAINT recruitment_interview_question_snapshots_ordinal_unique UNIQUE (interview_id, ordinal),
  CONSTRAINT recruitment_interview_question_snapshots_id_nonempty CHECK (btrim(question_id) <> ''),
  CONSTRAINT recruitment_interview_question_snapshots_ordinal_nonnegative CHECK (ordinal >= 0),
  CONSTRAINT recruitment_interview_question_snapshots_prompt_valid CHECK (
    btrim(prompt) <> '' AND char_length(prompt) <= 5000
  ),
  CONSTRAINT recruitment_interview_question_snapshots_help_text_length CHECK (
    help_text IS NULL OR char_length(help_text) <= 5000
  ),
  CONSTRAINT recruitment_interview_question_snapshots_kind_valid CHECK (
    kind IN ('text', 'list', 'radio', 'check')
  ),
  CONSTRAINT recruitment_interview_question_snapshots_alternatives_array CHECK (
    jsonb_typeof(alternatives) = 'array'
  ),
  CONSTRAINT recruitment_interview_question_snapshots_kind_alternatives CHECK (
    (kind = 'text' AND jsonb_array_length(alternatives) = 0)
    OR (kind IN ('list', 'radio', 'check') AND jsonb_array_length(alternatives) > 0)
  )
);

CREATE OR REPLACE FUNCTION prevent_recruitment_interview_question_snapshot_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Recruitment interview question snapshots are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recruitment_interview_question_snapshots_immutable
  ON recruitment_interview_question_snapshots;
CREATE TRIGGER recruitment_interview_question_snapshots_immutable
  BEFORE UPDATE OR DELETE ON recruitment_interview_question_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION prevent_recruitment_interview_question_snapshot_mutation();

CREATE INDEX IF NOT EXISTS recruitment_interview_schema_questions_schema_order
  ON recruitment_interview_schema_questions (interview_schema_id, ordinal);
CREATE INDEX IF NOT EXISTS recruitment_interview_question_snapshots_interview_order
  ON recruitment_interview_question_snapshots (interview_id, ordinal);

CREATE TABLE IF NOT EXISTS recruitment_interview_conducts (
  interview_id text PRIMARY KEY REFERENCES recruitment_interviews(interview_id),
  answers jsonb NOT NULL,
  explanatory_power integer NOT NULL,
  role_model integer NOT NULL,
  suitability integer NOT NULL,
  finalized_by_person_id text NOT NULL REFERENCES person_profiles(person_id),
  finalized_at timestamptz NOT NULL,
  interview_revision integer NOT NULL,
  CONSTRAINT recruitment_interview_conducts_answers_array CHECK (jsonb_typeof(answers) = 'array'),
  CONSTRAINT recruitment_interview_conducts_explanatory_power CHECK (explanatory_power BETWEEN 0 AND 10),
  CONSTRAINT recruitment_interview_conducts_role_model CHECK (role_model BETWEEN 0 AND 10),
  CONSTRAINT recruitment_interview_conducts_suitability CHECK (suitability BETWEEN 0 AND 10),
  CONSTRAINT recruitment_interview_conducts_revision_nonnegative CHECK (interview_revision >= 0),
  CONSTRAINT recruitment_interview_conducts_interview_revision_unique UNIQUE (interview_id, interview_revision)
);

CREATE TABLE IF NOT EXISTS recruitment_interview_cancellations (
  interview_id text PRIMARY KEY REFERENCES recruitment_interviews(interview_id),
  cancelled_by_person_id text NOT NULL REFERENCES person_profiles(person_id),
  cancelled_at timestamptz NOT NULL,
  interview_revision integer NOT NULL,
  CONSTRAINT recruitment_interview_cancellations_revision_nonnegative CHECK (interview_revision >= 0),
  CONSTRAINT recruitment_interview_cancellations_interview_revision_unique UNIQUE (interview_id, interview_revision)
);

CREATE TABLE IF NOT EXISTS recruitment_interview_lifecycle_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL,
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  kind text NOT NULL,
  interview_id text NOT NULL REFERENCES recruitment_interviews(interview_id),
  resulting_revision integer NOT NULL,
  committed_at timestamptz NOT NULL,
  CONSTRAINT recruitment_interview_lifecycle_receipts_id_nonempty CHECK (btrim(command_id) <> ''),
  CONSTRAINT recruitment_interview_lifecycle_receipts_digest CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT recruitment_interview_lifecycle_receipts_command_json_object CHECK (jsonb_typeof(command_json) = 'object'),
  CONSTRAINT recruitment_interview_lifecycle_receipts_observation_json_object CHECK (jsonb_typeof(observation_json) = 'object'),
  CONSTRAINT recruitment_interview_lifecycle_receipts_kind CHECK (kind IN ('InterviewFinalized', 'InterviewCancelled')),
  CONSTRAINT recruitment_interview_lifecycle_receipts_revision_nonnegative CHECK (resulting_revision >= 0),
  CONSTRAINT recruitment_interview_lifecycle_receipts_interview_kind_unique UNIQUE (interview_id, kind)
);

CREATE TABLE IF NOT EXISTS recruitment_interview_lifecycle_audit (
  command_id text PRIMARY KEY,
  interview_id text NOT NULL REFERENCES recruitment_interviews(interview_id),
  kind text NOT NULL,
  actor_person_id text NOT NULL REFERENCES person_profiles(person_id),
  resulting_revision integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT recruitment_interview_lifecycle_audit_kind CHECK (kind IN ('InterviewFinalized', 'InterviewCancelled')),
  CONSTRAINT recruitment_interview_lifecycle_audit_actor_nonempty CHECK (btrim(actor_person_id) <> ''),
  CONSTRAINT recruitment_interview_lifecycle_audit_revision_nonnegative CHECK (resulting_revision >= 0),
  CONSTRAINT recruitment_interview_lifecycle_audit_receipt_fk
    FOREIGN KEY (command_id) REFERENCES recruitment_interview_lifecycle_command_receipts(command_id),
  CONSTRAINT recruitment_interview_lifecycle_audit_interview_kind_fk
    FOREIGN KEY (interview_id, kind)
    REFERENCES recruitment_interview_lifecycle_command_receipts(interview_id, kind)
);

CREATE OR REPLACE FUNCTION prevent_recruitment_interview_lifecycle_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Recruitment interview lifecycle records are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recruitment_interview_conducts_immutable
  ON recruitment_interview_conducts;
CREATE TRIGGER recruitment_interview_conducts_immutable
  BEFORE UPDATE OR DELETE ON recruitment_interview_conducts
  FOR EACH ROW EXECUTE FUNCTION prevent_recruitment_interview_lifecycle_mutation();

DROP TRIGGER IF EXISTS recruitment_interview_cancellations_immutable
  ON recruitment_interview_cancellations;
CREATE TRIGGER recruitment_interview_cancellations_immutable
  BEFORE UPDATE OR DELETE ON recruitment_interview_cancellations
  FOR EACH ROW EXECUTE FUNCTION prevent_recruitment_interview_lifecycle_mutation();

DROP TRIGGER IF EXISTS recruitment_interview_lifecycle_command_receipts_immutable
  ON recruitment_interview_lifecycle_command_receipts;
CREATE TRIGGER recruitment_interview_lifecycle_command_receipts_immutable
  BEFORE UPDATE OR DELETE ON recruitment_interview_lifecycle_command_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_recruitment_interview_lifecycle_mutation();

DROP TRIGGER IF EXISTS recruitment_interview_lifecycle_audit_immutable
  ON recruitment_interview_lifecycle_audit;
CREATE TRIGGER recruitment_interview_lifecycle_audit_immutable
  BEFORE UPDATE OR DELETE ON recruitment_interview_lifecycle_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_recruitment_interview_lifecycle_mutation();

CREATE INDEX IF NOT EXISTS recruitment_interview_lifecycle_audit_interview
  ON recruitment_interview_lifecycle_audit (interview_id, resulting_revision);
