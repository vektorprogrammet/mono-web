-- 0104: Returning assistant registration and immutable classification provenance.
ALTER TABLE public.admission_periods
  ADD CONSTRAINT admission_periods_id_department_key UNIQUE (admission_period_id, department_id);
CREATE TABLE public.admission_returning_registrations (
  registration_id text PRIMARY KEY CHECK (registration_id ~ '^returning-registration-[a-f0-9]{64}$'),
  application_id text NOT NULL,
  applicant_id text NOT NULL,
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  placement_id text NOT NULL REFERENCES public.assistant_placements(placement_id),
  department_id text NOT NULL REFERENCES public.admission_period_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
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
  registered_at timestamptz NOT NULL,
  FOREIGN KEY (application_id, applicant_id)
    REFERENCES public.admission_applications(application_id, applicant_id),
  FOREIGN KEY (admission_period_id, department_id)
    REFERENCES public.admission_periods(admission_period_id, department_id),
  UNIQUE (application_id, revision),
  UNIQUE (applicant_id, admission_period_id, revision)
);
CREATE INDEX admission_returning_registrations_current
  ON public.admission_returning_registrations(application_id, revision DESC);
CREATE TABLE public.admission_returning_registration_placements (
  registration_id text NOT NULL REFERENCES public.admission_returning_registrations(registration_id),
  placement_id text NOT NULL REFERENCES public.assistant_placements(placement_id),
  PRIMARY KEY (registration_id, placement_id)
);
CREATE TABLE public.admission_returning_registration_teams (
  registration_id text NOT NULL REFERENCES public.admission_returning_registrations(registration_id),
  team_id text NOT NULL REFERENCES public.organization_teams(team_id),
  PRIMARY KEY (registration_id, team_id)
);
CREATE TABLE public.admission_returning_registration_audit (
  registration_id text NOT NULL REFERENCES public.admission_returning_registrations(registration_id),
  revision integer NOT NULL,
  applicant_id text NOT NULL REFERENCES public.admission_applicants(applicant_id),
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  command_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('Registered', 'Reapplied')),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (registration_id, revision)
);
CREATE TABLE public.admission_returning_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  registration_id text NOT NULL REFERENCES public.admission_returning_registrations(registration_id),
  committed_at timestamptz NOT NULL
);
CREATE FUNCTION public.prevent_returning_registration_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Returning registration provenance is immutable'; END;
$$;
CREATE TRIGGER admission_returning_registration_immutable
  BEFORE UPDATE OR DELETE ON public.admission_returning_registrations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_returning_registration_mutation();
CREATE TRIGGER admission_returning_registration_placements_immutable
  BEFORE UPDATE OR DELETE ON public.admission_returning_registration_placements
  FOR EACH ROW EXECUTE FUNCTION public.prevent_returning_registration_mutation();
CREATE TRIGGER admission_returning_registration_teams_immutable
  BEFORE UPDATE OR DELETE ON public.admission_returning_registration_teams
  FOR EACH ROW EXECUTE FUNCTION public.prevent_returning_registration_mutation();
CREATE TRIGGER admission_returning_registration_audit_immutable
  BEFORE UPDATE OR DELETE ON public.admission_returning_registration_audit
  FOR EACH ROW EXECUTE FUNCTION public.prevent_returning_registration_mutation();
