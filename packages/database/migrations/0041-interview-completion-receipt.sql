CREATE TABLE public.recruitment_interview_completion_outbox (
  effect_id text PRIMARY KEY,
  effect_type text NOT NULL CHECK (effect_type = 'SendInterviewCompletionReceipt'),
  command_id text NOT NULL UNIQUE REFERENCES public.recruitment_interview_lifecycle_command_receipts(command_id),
  interview_id text NOT NULL REFERENCES public.recruitment_interviews(interview_id),
  application_id text NOT NULL REFERENCES public.admission_applications(application_id),
  interview_revision integer NOT NULL CHECK (interview_revision > 0),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_json) = 'object'),
  delivery_envelope jsonb,
  status text NOT NULL DEFAULT 'Pending' CHECK (
    status IN ('Pending', 'Processing', 'Delivered', 'Failed', 'Quarantined')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_id text,
  claimed_at timestamptz,
  delivered_at timestamptz,
  provider_reference text,
  last_failure_tag text,
  CONSTRAINT recruitment_interview_completion_outbox_claim_state CHECK (
    (status = 'Processing' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'Processing' AND claim_id IS NULL AND claimed_at IS NULL)
  ),
  CONSTRAINT recruitment_interview_completion_outbox_delivery_state CHECK (
    (status = 'Delivered' AND delivered_at IS NOT NULL AND provider_reference IS NOT NULL)
    OR (status <> 'Delivered' AND delivered_at IS NULL AND provider_reference IS NULL)
  ),
  CONSTRAINT recruitment_interview_completion_outbox_envelope_shape CHECK (
    delivery_envelope IS NULL OR (
      jsonb_typeof(delivery_envelope) = 'object'
      AND delivery_envelope ->> '_tag' = effect_type
      AND delivery_envelope ->> 'effectId' = effect_id
      AND delivery_envelope ->> 'commandId' = command_id
      AND delivery_envelope ->> 'interviewId' = interview_id
      AND delivery_envelope ->> 'applicationId' = application_id
      AND (delivery_envelope ->> 'interviewRevision')::integer = interview_revision
      AND delivery_envelope ?& ARRAY[
        '_tag', 'effectId', 'commandId', 'interviewId', 'applicationId',
        'interviewRevision', 'applicantDisplayName', 'applicantEmail',
        'interviewerDisplayName', 'interviewerEmail'
      ]
    )
  )
);

CREATE INDEX recruitment_interview_completion_outbox_claim_order
  ON public.recruitment_interview_completion_outbox (attempts, command_id)
  WHERE status IN ('Pending', 'Failed');

CREATE FUNCTION public.freeze_recruitment_interview_completion_envelope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.delivery_envelope IS NOT NULL
    AND NEW.delivery_envelope IS DISTINCT FROM OLD.delivery_envelope THEN
    RAISE EXCEPTION 'Interview completion delivery envelope is immutable';
  END IF;
  IF OLD.delivery_envelope IS NULL AND NEW.delivery_envelope IS NOT NULL
    AND (OLD.status <> 'Processing' OR NEW.claim_id IS DISTINCT FROM OLD.claim_id) THEN
    RAISE EXCEPTION 'Interview completion delivery envelope requires active claim';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recruitment_interview_completion_envelope_immutable
BEFORE UPDATE ON public.recruitment_interview_completion_outbox
FOR EACH ROW EXECUTE FUNCTION public.freeze_recruitment_interview_completion_envelope();
