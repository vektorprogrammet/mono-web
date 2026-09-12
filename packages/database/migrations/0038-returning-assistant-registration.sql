-- 0104: Returning assistant registration and immutable classification provenance.
CREATE OR REPLACE FUNCTION public.version_applicant_identity_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vektorprogrammet:person-authorization:v1:' || NEW.person_id, 0)
  );
  UPDATE public.admission_applicants SET applicant_id=applicant_id WHERE applicant_id=NEW.applicant_id;
  RETURN NEW;
END $$;
ALTER TABLE public.admission_periods
  ADD CONSTRAINT admission_periods_id_department_key UNIQUE (admission_period_id, department_id),
  ADD CONSTRAINT admission_periods_id_semester_key UNIQUE (admission_period_id, semester_id);
ALTER TABLE public.admission_applications
  ADD CONSTRAINT admission_applications_id_period_key UNIQUE (application_id, admission_period_id);
ALTER TABLE public.assistant_placements
  ADD CONSTRAINT assistant_placements_id_person_key UNIQUE (placement_id, person_id);
ALTER TABLE public.admission_application_outbox
  ADD COLUMN origin text NOT NULL DEFAULT 'PublicApplication',
  ADD COLUMN public_command_id text GENERATED ALWAYS AS (
    CASE WHEN origin = 'PublicApplication' THEN command_id ELSE NULL END
  ) STORED,
  ADD COLUMN returning_command_id text GENERATED ALWAYS AS (
    CASE WHEN origin = 'ReturningAssistant' THEN command_id ELSE NULL END
  ) STORED,
  ADD CONSTRAINT admission_application_outbox_origin_check
    CHECK (
      (origin = 'PublicApplication' AND public_command_id IS NOT NULL AND returning_command_id IS NULL)
      OR (origin = 'ReturningAssistant' AND public_command_id IS NULL AND returning_command_id IS NOT NULL)
    ),
  ADD CONSTRAINT admission_application_outbox_public_command_fk
    FOREIGN KEY (public_command_id)
    REFERENCES public.admission_application_command_receipts(command_id);
CREATE TABLE public.admission_returning_registrations (
  registration_id text PRIMARY KEY CHECK (registration_id ~ '^returning-registration-[a-f0-9]{64}$'),
  application_id text NOT NULL,
  applicant_id text NOT NULL,
  person_id text NOT NULL,
  placement_id text NOT NULL,
  department_id text NOT NULL,
  semester_id text NOT NULL,
  admission_period_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  command_id text NOT NULL,
  year_of_study integer NOT NULL CHECK (year_of_study BETWEEN 1 AND 5),
  monday_unavailable boolean NOT NULL,
  tuesday_unavailable boolean NOT NULL,
  wednesday_unavailable boolean NOT NULL,
  thursday_unavailable boolean NOT NULL,
  friday_unavailable boolean NOT NULL,
  position_weeks integer NOT NULL CHECK (position_weeks IN (4, 8)),
  preferred_group text NOT NULL CHECK (preferred_group IN ('all', 'block-1', 'block-2')),
  language text NOT NULL CHECK (language IN ('Norsk', 'Engelsk', 'Norsk og engelsk')),
  preferred_school text NULL CHECK (preferred_school IS NULL OR char_length(preferred_school) <= 255),
  team_interest boolean NOT NULL,
  team_ids jsonb NOT NULL CHECK (jsonb_typeof(team_ids) = 'array'),
  FOREIGN KEY (application_id, applicant_id)
    REFERENCES public.admission_applications(application_id, applicant_id),
  FOREIGN KEY (application_id, admission_period_id)
    REFERENCES public.admission_applications(application_id, admission_period_id),
  FOREIGN KEY (applicant_id, person_id)
    REFERENCES public.applicant_account_links(applicant_id, person_id),
  FOREIGN KEY (placement_id, person_id)
    REFERENCES public.assistant_placements(placement_id, person_id),
  FOREIGN KEY (department_id)
    REFERENCES public.admission_period_departments(department_id),
  FOREIGN KEY (admission_period_id, department_id)
    REFERENCES public.admission_periods(admission_period_id, department_id),
  FOREIGN KEY (admission_period_id, semester_id)
    REFERENCES public.admission_periods(admission_period_id, semester_id),
  UNIQUE (application_id, revision),
  UNIQUE (applicant_id, admission_period_id, revision),
  UNIQUE (registration_id, revision),
  UNIQUE (registration_id, person_id, applicant_id)
);
CREATE INDEX admission_returning_registrations_current
  ON public.admission_returning_registrations(applicant_id, admission_period_id, revision DESC);
CREATE TABLE public.admission_returning_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  registration_id text NOT NULL,
  person_id text NOT NULL,
  applicant_id text NOT NULL,
  committed_at timestamptz NOT NULL,
  FOREIGN KEY (registration_id, person_id, applicant_id)
    REFERENCES public.admission_returning_registrations(registration_id, person_id, applicant_id)
);
ALTER TABLE public.admission_application_outbox
  ADD CONSTRAINT admission_application_outbox_returning_command_fk
    FOREIGN KEY (returning_command_id)
    REFERENCES public.admission_returning_command_receipts(command_id);
CREATE FUNCTION public.prevent_returning_registration_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Returning registration provenance is immutable'; END;
$$;
CREATE TRIGGER admission_returning_registration_immutable
  BEFORE UPDATE OR DELETE ON public.admission_returning_registrations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_returning_registration_mutation();
CREATE TRIGGER admission_returning_registration_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.admission_returning_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_returning_registration_mutation();
