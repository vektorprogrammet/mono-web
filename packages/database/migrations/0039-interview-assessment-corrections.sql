-- 0105: append-only corrections to completed interview assessments.
-- The original conduct row remains immutable. A view derives one effective assessment.
CREATE TABLE IF NOT EXISTS public.recruitment_interview_correction_assessments (
  interview_id text NOT NULL REFERENCES public.recruitment_interviews(interview_id),
  predecessor_revision integer NOT NULL,
  resulting_revision integer NOT NULL,
  answers jsonb NOT NULL,
  explanatory_power integer NOT NULL,
  role_model integer NOT NULL,
  suitability integer NOT NULL,
  recommendation text NOT NULL,
  corrected_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  corrected_at timestamptz NOT NULL,
  command_id text NOT NULL UNIQUE,
  CONSTRAINT recruitment_interview_correction_assessments_pk
    PRIMARY KEY (interview_id, resulting_revision),
  CONSTRAINT recruitment_interview_correction_assessments_predecessor_nonnegative
    CHECK (predecessor_revision >= 0),
  CONSTRAINT recruitment_interview_correction_assessments_revision_order
    CHECK (resulting_revision > predecessor_revision),
  CONSTRAINT recruitment_interview_correction_assessments_answers_array
    CHECK (jsonb_typeof(answers) = 'array'),
  CONSTRAINT recruitment_interview_correction_assessments_explanatory_power
    CHECK (explanatory_power BETWEEN 0 AND 10),
  CONSTRAINT recruitment_interview_correction_assessments_role_model
    CHECK (role_model BETWEEN 0 AND 10),
  CONSTRAINT recruitment_interview_correction_assessments_suitability
    CHECK (suitability BETWEEN 0 AND 10),
  CONSTRAINT recruitment_interview_correction_assessments_recommendation
    CHECK (recommendation IN ('Ja', 'Kanskje', 'Nei')),
  CONSTRAINT recruitment_interview_correction_assessments_command_nonempty
    CHECK (btrim(command_id) <> '')
);

CREATE TABLE IF NOT EXISTS public.recruitment_interview_correction_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL,
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  interview_id text NOT NULL,
  predecessor_revision integer NOT NULL,
  resulting_revision integer NOT NULL,
  committed_at timestamptz NOT NULL,
  CONSTRAINT recruitment_interview_correction_receipts_digest
    CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT recruitment_interview_correction_receipts_command_json_object
    CHECK (jsonb_typeof(command_json) = 'object'),
  CONSTRAINT recruitment_interview_correction_receipts_observation_json_object
    CHECK (jsonb_typeof(observation_json) = 'object'),
  CONSTRAINT recruitment_interview_correction_receipts_revision_nonnegative
    CHECK (predecessor_revision >= 0 AND resulting_revision > predecessor_revision),
  CONSTRAINT recruitment_interview_correction_receipts_assessment_fk
    FOREIGN KEY (interview_id, resulting_revision)
    REFERENCES public.recruitment_interview_correction_assessments(interview_id, resulting_revision),
  CONSTRAINT recruitment_interview_correction_receipts_command_fk
    FOREIGN KEY (command_id) REFERENCES public.recruitment_interview_correction_assessments(command_id)
);

CREATE TABLE IF NOT EXISTS public.recruitment_interview_correction_audit (
  command_id text PRIMARY KEY,
  interview_id text NOT NULL,
  actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  predecessor_revision integer NOT NULL,
  resulting_revision integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT recruitment_interview_correction_audit_receipt_fk
    FOREIGN KEY (command_id) REFERENCES public.recruitment_interview_correction_command_receipts(command_id),
  CONSTRAINT recruitment_interview_correction_audit_assessment_fk
    FOREIGN KEY (interview_id, resulting_revision)
    REFERENCES public.recruitment_interview_correction_assessments(interview_id, resulting_revision),
  CONSTRAINT recruitment_interview_correction_audit_revision_nonnegative
    CHECK (predecessor_revision >= 0 AND resulting_revision > predecessor_revision),
  CONSTRAINT recruitment_interview_correction_audit_actor_nonempty
    CHECK (btrim(actor_person_id) <> '')
);

CREATE OR REPLACE FUNCTION public.prevent_recruitment_interview_correction_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Recruitment interview corrections are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recruitment_interview_correction_assessments_immutable
  ON public.recruitment_interview_correction_assessments;
CREATE TRIGGER recruitment_interview_correction_assessments_immutable
  BEFORE UPDATE OR DELETE ON public.recruitment_interview_correction_assessments
  FOR EACH ROW EXECUTE FUNCTION public.prevent_recruitment_interview_correction_mutation();

DROP TRIGGER IF EXISTS recruitment_interview_correction_receipts_immutable
  ON public.recruitment_interview_correction_command_receipts;
CREATE TRIGGER recruitment_interview_correction_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.recruitment_interview_correction_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_recruitment_interview_correction_mutation();

DROP TRIGGER IF EXISTS recruitment_interview_correction_audit_immutable
  ON public.recruitment_interview_correction_audit;
CREATE TRIGGER recruitment_interview_correction_audit_immutable
  BEFORE UPDATE OR DELETE ON public.recruitment_interview_correction_audit
  FOR EACH ROW EXECUTE FUNCTION public.prevent_recruitment_interview_correction_mutation();

CREATE INDEX IF NOT EXISTS recruitment_interview_correction_assessments_order
  ON public.recruitment_interview_correction_assessments (interview_id, resulting_revision);
CREATE INDEX IF NOT EXISTS recruitment_interview_correction_audit_order
  ON public.recruitment_interview_correction_audit (interview_id, resulting_revision);

CREATE OR REPLACE VIEW public.recruitment_interview_effective_assessments AS
SELECT
  conduct.interview_id,
  COALESCE(correction.answers, conduct.answers) AS answers,
  COALESCE(correction.explanatory_power, conduct.explanatory_power) AS explanatory_power,
  COALESCE(correction.role_model, conduct.role_model) AS role_model,
  COALESCE(correction.suitability, conduct.suitability) AS suitability,
  COALESCE(correction.recommendation, conduct.recommendation) AS recommendation,
  conduct.finalized_by_person_id AS finalized_by_person_id,
  conduct.finalized_at AS finalized_at,
  conduct.interview_revision AS original_interview_revision,
  COALESCE(correction.resulting_revision, conduct.interview_revision) AS effective_revision,
  correction.corrected_by_person_id AS effective_corrected_by_person_id,
  correction.corrected_at AS effective_corrected_at
FROM public.recruitment_interview_conducts AS conduct
LEFT JOIN LATERAL (
  SELECT assessment.answers, assessment.explanatory_power, assessment.role_model,
    assessment.suitability, assessment.recommendation, assessment.resulting_revision,
    assessment.corrected_by_person_id, assessment.corrected_at
  FROM public.recruitment_interview_correction_assessments AS assessment
  WHERE assessment.interview_id = conduct.interview_id
  ORDER BY assessment.resulting_revision DESC
  LIMIT 1
) AS correction ON true;
