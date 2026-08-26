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
