-- Admission outcomes are Admitted or Rejected (spec 0027). Substitute is no outcome and no role:
-- an Admitted assistant without a school placement stays an assistant and may cover a dated
-- service. Two steps now: an interview derives Ja as Admitted and Nei as Rejected, Rekruttering
-- decides Kanskje and returning assistants, and the school coordinator announces the one final
-- outcome once. The revision history stays append-only. Earlier rows are neither rewritten nor
-- deleted; the Substitute literal survives in them as internal history only.

-- A revision names where it comes from. A Decision is a human choice of Rekruttering. A
-- Recommendation is the outcome that an interview derived at the announcement. A
-- SemanticUpgrade is this migration's Admitted successor of a current Substitute. Only a
-- Decision has a decider; no person is invented for the other two.
ALTER TABLE public.admission_application_outcomes
  ADD COLUMN provenance text NOT NULL DEFAULT 'Decision'
    CONSTRAINT admission_application_outcomes_provenance
    CHECK (provenance IN ('Decision', 'Recommendation', 'SemanticUpgrade'));
ALTER TABLE public.admission_application_outcomes ALTER COLUMN decided_by_person_id DROP NOT NULL;
ALTER TABLE public.admission_application_outcomes
  ADD CONSTRAINT admission_application_outcomes_decider_by_provenance
    CHECK ((provenance = 'Decision') = (decided_by_person_id IS NOT NULL));

-- No new revision, also through direct SQL, may say Substitute. NOT VALID checks every insert and
-- update from now on and leaves the preserved history unchecked. Do not validate it: the old
-- literals are meant to stay.
ALTER TABLE public.admission_application_outcomes
  ADD CONSTRAINT admission_application_outcomes_no_new_substitute
    CHECK (outcome IN ('Admitted', 'Rejected')) NOT VALID;

-- The announcement is the terminal fact: one row per application, written once, naming the
-- revision that is final. A decision or a second announcement can follow it no more.
CREATE TABLE public.admission_outcome_announcements (
  application_id text PRIMARY KEY REFERENCES public.admission_applications(application_id),
  outcome text NOT NULL CHECK (outcome IN ('Admitted', 'Rejected')),
  outcome_revision integer NOT NULL,
  announced_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  announced_at timestamptz NOT NULL,
  FOREIGN KEY (application_id, outcome_revision)
    REFERENCES public.admission_application_outcomes(application_id, revision),
  CONSTRAINT admission_outcome_announcements_announced_at_ms
    CHECK (announced_at = date_trunc('milliseconds', announced_at, 'UTC'))
);

CREATE FUNCTION public.guard_admission_outcome_announcement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'An admission outcome announcement is final';
  END IF;
  IF NEW.outcome_revision IS DISTINCT FROM (SELECT max(revision)
        FROM public.admission_application_outcomes WHERE application_id = NEW.application_id)
    OR NOT EXISTS (SELECT 1 FROM public.admission_application_outcomes
        WHERE application_id = NEW.application_id AND revision = NEW.outcome_revision
          AND outcome = NEW.outcome) THEN
    RAISE EXCEPTION 'An admission outcome announcement must announce the current outcome revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admission_outcome_announcement_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.admission_outcome_announcements
  FOR EACH ROW EXECUTE FUNCTION public.guard_admission_outcome_announcement();

-- Once announced, the history takes no further revision.
CREATE OR REPLACE FUNCTION public.guard_admission_application_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Admission outcome history is append-only';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admission_outcome_announcements
      WHERE application_id = NEW.application_id) THEN
    RAISE EXCEPTION 'An announced admission outcome is final';
  END IF;
  IF NEW.revision <> COALESCE((SELECT max(revision) FROM public.admission_application_outcomes
      WHERE application_id = NEW.application_id), 0) + 1 THEN
    RAISE EXCEPTION 'Admission outcome revision must follow the current revision';
  END IF;
  RETURN NEW;
END;
$$;

-- Every application whose current outcome is the retired Substitute gets one Admitted revision
-- after it. Nobody is announced to and no mail is queued: the announcement is a separate step.
INSERT INTO public.admission_application_outcomes (
  application_id, revision, outcome, decided_by_person_id, decided_at, provenance
)
SELECT latest_outcome.application_id, latest_outcome.revision + 1, 'Admitted', NULL,
  date_trunc('milliseconds', now(), 'UTC'), 'SemanticUpgrade'
FROM public.admission_application_outcomes AS latest_outcome
WHERE latest_outcome.outcome = 'Substitute'
  AND latest_outcome.revision = (SELECT max(revision) FROM public.admission_application_outcomes
    WHERE application_id = latest_outcome.application_id);

-- A covering person is an assistant; the kind of coverer is no persisted fact. Earlier audit
-- events keep the kind they recorded.
CREATE OR REPLACE FUNCTION public.guard_school_service_coverage_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'School service coverage record is immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new school service coverage record cannot be withdrawn';
    END IF;
    IF EXISTS (SELECT 1 FROM public.school_service_absences
        WHERE absence_id = NEW.absence_id AND person_id = NEW.covering_person_id) THEN
      RAISE EXCEPTION 'An absent assistant cannot cover the own absence';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.coverage_id IS DISTINCT FROM OLD.coverage_id
    OR NEW.absence_id IS DISTINCT FROM OLD.absence_id
    OR NEW.covering_person_id IS DISTINCT FROM OLD.covering_person_id
    OR NEW.recorded_by_person_id IS DISTINCT FROM OLD.recorded_by_person_id
    OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    OR OLD.withdrawn_at IS NOT NULL
    OR NEW.withdrawn_at IS NULL THEN
    RAISE EXCEPTION 'A school service coverage record allows only its withdrawal';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE public.school_service_coverage_records DROP COLUMN coverer_kind;
