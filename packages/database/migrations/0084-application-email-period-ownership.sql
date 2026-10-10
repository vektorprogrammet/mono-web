-- Applicant statements are unverified submission evidence, not mutable Person profiles.
-- Equal email addresses never establish shared ownership. Existing rows and links stay intact.
ALTER TABLE public.admission_applicants
  DROP CONSTRAINT admission_applicants_normalized_email_key,
  ADD CONSTRAINT admission_applicants_id_email_unique UNIQUE (applicant_id, normalized_email);

ALTER TABLE public.admission_applications
  ADD COLUMN normalized_email text;

-- Preserve old application identities and every recorded value; derive only the new key.
UPDATE public.admission_applications AS application
SET normalized_email = applicant.normalized_email
FROM public.admission_applicants AS applicant
WHERE applicant.applicant_id = application.applicant_id;

ALTER TABLE public.admission_applications
  ALTER COLUMN normalized_email SET NOT NULL,
  ADD CONSTRAINT admission_applications_email_nonempty CHECK (normalized_email <> ''),
  ADD CONSTRAINT admission_applications_applicant_email_fk
    FOREIGN KEY (applicant_id, normalized_email)
    REFERENCES public.admission_applicants (applicant_id, normalized_email),
  ADD CONSTRAINT admission_applications_period_email_unique
    UNIQUE (admission_period_id, normalized_email);

CREATE FUNCTION public.guard_admission_applicant_statement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Applicant submission statements are immutable' USING ERRCODE = '23514';
  END IF;
  -- Identity-link custody versions the row with a no-op UPDATE. Keep that fence intact.
  RETURN NEW;
END $$;

CREATE TRIGGER admission_applicant_statement_immutable
  BEFORE UPDATE OR DELETE ON public.admission_applicants
  FOR EACH ROW EXECUTE FUNCTION public.guard_admission_applicant_statement();

CREATE FUNCTION public.derive_admission_application_email() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  applicant_email text;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.applicant_id IS DISTINCT FROM OLD.applicant_id
    OR NEW.admission_period_id IS DISTINCT FROM OLD.admission_period_id
    OR NEW.normalized_email IS DISTINCT FROM OLD.normalized_email
  ) THEN
    RAISE EXCEPTION 'Application applicant, period and normalized email are immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT normalized_email INTO applicant_email
  FROM public.admission_applicants
  WHERE applicant_id = NEW.applicant_id;

  IF applicant_email IS NULL THEN
    RAISE EXCEPTION 'Application applicant does not exist' USING ERRCODE = '23503';
  END IF;
  IF NEW.normalized_email IS NOT NULL AND NEW.normalized_email <> applicant_email THEN
    RAISE EXCEPTION 'Application email does not match applicant' USING ERRCODE = '23514';
  END IF;
  NEW.normalized_email := applicant_email;
  RETURN NEW;
END $$;

CREATE TRIGGER admission_application_email_derived
  BEFORE INSERT OR UPDATE ON public.admission_applications
  FOR EACH ROW EXECUTE FUNCTION public.derive_admission_application_email();
