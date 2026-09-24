CREATE TABLE public.recruitment_maintenance_command_receipts (
  actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id) ON DELETE RESTRICT,
  command_id text NOT NULL CHECK (command_id ~ '^[A-Za-z0-9_-]{22,128}$'),
  command_digest text NOT NULL CHECK (command_digest ~ '^[a-f0-9]{64}$'),
  result_json jsonb NOT NULL,
  PRIMARY KEY(actor_person_id,command_id)
);
CREATE TABLE public.recruitment_questionnaire_history (
  actor_person_id text NOT NULL,
  command_id text NOT NULL,
  interview_schema_id text NOT NULL REFERENCES public.recruitment_interview_schemas(interview_schema_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  revision integer NOT NULL CHECK (revision >= 0),
  before_json jsonb,
  after_json jsonb NOT NULL,
  PRIMARY KEY(interview_schema_id,revision),
  FOREIGN KEY(actor_person_id,command_id) REFERENCES public.recruitment_maintenance_command_receipts(actor_person_id,command_id) ON DELETE RESTRICT
);
CREATE TABLE public.recruitment_staffing_history (
  actor_person_id text NOT NULL,
  command_id text NOT NULL,
  interview_id text NOT NULL REFERENCES public.recruitment_interviews(interview_id) ON DELETE RESTRICT,
  department_id text NOT NULL REFERENCES public.organization_departments(department_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  revision integer NOT NULL CHECK (revision > 0),
  before_json jsonb NOT NULL,
  after_json jsonb NOT NULL,
  PRIMARY KEY(interview_id,revision),
  FOREIGN KEY(actor_person_id,command_id) REFERENCES public.recruitment_maintenance_command_receipts(actor_person_id,command_id) ON DELETE RESTRICT
);
CREATE FUNCTION public.freeze_recruitment_maintenance_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Recruitment maintenance evidence is immutable'; END $$;
CREATE TRIGGER recruitment_maintenance_receipts_immutable BEFORE UPDATE OR DELETE ON public.recruitment_maintenance_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.freeze_recruitment_maintenance_evidence();
CREATE TRIGGER recruitment_questionnaire_history_immutable BEFORE UPDATE OR DELETE ON public.recruitment_questionnaire_history
  FOR EACH ROW EXECUTE FUNCTION public.freeze_recruitment_maintenance_evidence();
CREATE TRIGGER recruitment_staffing_history_immutable BEFORE UPDATE OR DELETE ON public.recruitment_staffing_history
  FOR EACH ROW EXECUTE FUNCTION public.freeze_recruitment_maintenance_evidence();

ALTER TABLE public.recruitment_schedule_command_receipts ADD COLUMN envelope_sha256 text CHECK (envelope_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE public.recruitment_invitation_response_audit ADD COLUMN envelope_sha256 text CHECK (envelope_sha256 ~ '^[a-f0-9]{64}$');

-- Old envelopes can be sealed once, only after the adapter validates them against
-- the original independent canonical checks. No content or previous seal can change.
CREATE FUNCTION public.freeze_recruitment_envelope_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.envelope_sha256 IS NULL AND NEW.envelope_sha256 IS NOT NULL
    AND (to_jsonb(OLD) - 'envelope_sha256') = (to_jsonb(NEW) - 'envelope_sha256') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Recruitment delivery evidence is immutable';
END $$;
CREATE TRIGGER recruitment_schedule_receipts_immutable BEFORE UPDATE OR DELETE ON public.recruitment_schedule_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.freeze_recruitment_envelope_evidence();
DROP TRIGGER recruitment_invitation_response_audit_immutable ON public.recruitment_invitation_response_audit;
CREATE TRIGGER recruitment_invitation_response_audit_immutable BEFORE UPDATE OR DELETE ON public.recruitment_invitation_response_audit
  FOR EACH ROW EXECUTE FUNCTION public.freeze_recruitment_envelope_evidence();
