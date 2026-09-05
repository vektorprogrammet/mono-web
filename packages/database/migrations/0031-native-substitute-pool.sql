-- 0094 amendment: application year edits now advance the existing canonical
-- nonnegative revision. Submission audit/receipts remain immutable at revision 0.
ALTER TABLE public.admission_applications DROP CONSTRAINT admission_applications_revision;
ALTER TABLE public.admission_applications ADD CONSTRAINT admission_applications_revision CHECK (revision >= 0);

-- Applicant identity and year of study remain in the canonical admission tables.
-- Missing preferences are represented by the absence of this row, never defaults.
CREATE TABLE public.admission_substitute_preferences (
  application_id text PRIMARY KEY REFERENCES public.admission_applications(application_id),
  active boolean NOT NULL,
  monday boolean NOT NULL,
  tuesday boolean NOT NULL,
  wednesday boolean NOT NULL,
  thursday boolean NOT NULL,
  friday boolean NOT NULL,
  language text NOT NULL CHECK (language IN ('Norwegian', 'English', 'NorwegianAndEnglish')),
  revision integer NOT NULL CHECK (revision >= 1)
);
