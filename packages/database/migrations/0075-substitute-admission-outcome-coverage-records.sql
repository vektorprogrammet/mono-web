-- Substitutes are an admission outcome: an admitted applicant without a placement is on call.
-- The system records absences and who covered each one; people agree on cover outside it.
-- This removes the substitute pool and the substitute offer, response, acknowledgement and
-- dispatch flow. Acknowledged coverage becomes coverage records, so closures keep their history.
-- Pool rows and unresolved offers have no successor: no native production data exists yet.

-- One outcome per application at a time; history is append-only and the highest revision rules.
CREATE TABLE public.admission_application_outcomes (
  application_id text NOT NULL REFERENCES public.admission_applications(application_id),
  revision integer NOT NULL CHECK (revision >= 1),
  outcome text NOT NULL CHECK (outcome IN ('Admitted','Substitute','Rejected')),
  decided_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (application_id, revision),
  CONSTRAINT admission_application_outcomes_decided_at_ms
    CHECK (decided_at = date_trunc('milliseconds', decided_at, 'UTC'))
);

CREATE FUNCTION public.guard_admission_application_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Admission outcome history is append-only';
  END IF;
  IF NEW.revision <> COALESCE((SELECT max(revision) FROM public.admission_application_outcomes
      WHERE application_id = NEW.application_id), 0) + 1 THEN
    RAISE EXCEPTION 'Admission outcome revision must follow the current revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admission_application_outcome_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.admission_application_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.guard_admission_application_outcome();

-- A coverage record names who covered one absence. Only its withdrawal may follow.
CREATE TABLE public.school_service_coverage_records (
  coverage_id text PRIMARY KEY CHECK (coverage_id ~ '^school-service-coverage-[a-f0-9]{64}$'),
  absence_id text NOT NULL REFERENCES public.school_service_absences(absence_id),
  covering_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  coverer_kind text NOT NULL CHECK (coverer_kind IN ('Assistant','Substitute')),
  recorded_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  recorded_at timestamptz NOT NULL,
  withdrawn_by_person_id text REFERENCES public.person_profiles(person_id),
  withdrawn_at timestamptz,
  UNIQUE (coverage_id, absence_id),
  CHECK ((withdrawn_by_person_id IS NULL) = (withdrawn_at IS NULL)),
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= recorded_at),
  CONSTRAINT school_service_coverage_records_recorded_at_ms
    CHECK (recorded_at = date_trunc('milliseconds', recorded_at, 'UTC')),
  CONSTRAINT school_service_coverage_records_withdrawn_at_ms
    CHECK (withdrawn_at = date_trunc('milliseconds', withdrawn_at, 'UTC'))
);
CREATE UNIQUE INDEX school_service_coverage_record_current
  ON public.school_service_coverage_records(absence_id) WHERE withdrawn_at IS NULL;

CREATE FUNCTION public.guard_school_service_coverage_record() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR NEW.coverer_kind IS DISTINCT FROM OLD.coverer_kind
    OR NEW.recorded_by_person_id IS DISTINCT FROM OLD.recorded_by_person_id
    OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
    OR OLD.withdrawn_at IS NOT NULL
    OR NEW.withdrawn_at IS NULL THEN
    RAISE EXCEPTION 'A school service coverage record allows only its withdrawal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_coverage_record_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.school_service_coverage_records
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_coverage_record();

-- Acknowledged substitute coverage keeps its identity digest, actor and time.
INSERT INTO public.school_service_coverage_records(
  coverage_id,absence_id,covering_person_id,coverer_kind,recorded_by_person_id,recorded_at)
SELECT replace(acknowledgement.acknowledgement_id,'school-service-coverage-acknowledgement-',
    'school-service-coverage-'),
  acknowledgement.absence_id,acknowledgement.candidate_person_id,'Substitute',
  acknowledgement.acknowledged_by_person_id,acknowledgement.acknowledged_at
FROM public.school_service_coverage_acknowledgements AS acknowledgement;

-- Closures reference the coverage record instead of the acknowledgement.
ALTER TABLE public.school_service_closures DISABLE TRIGGER school_service_closure_immutable;
ALTER TABLE public.school_service_closures ADD COLUMN coverage_id text;
UPDATE public.school_service_closures
SET coverage_id = replace(acknowledgement_id,'school-service-coverage-acknowledgement-',
  'school-service-coverage-')
WHERE acknowledgement_id IS NOT NULL;
-- Dropping the column also drops the acknowledgement foreign key and the old outcome check.
ALTER TABLE public.school_service_closures DROP COLUMN acknowledgement_id;
ALTER TABLE public.school_service_closures RENAME COLUMN substitute_person_id TO covering_person_id;
ALTER TABLE public.school_service_closures
  ADD CONSTRAINT school_service_closures_coverage_ref FOREIGN KEY (coverage_id, absence_id)
    REFERENCES public.school_service_coverage_records(coverage_id, absence_id),
  ADD CONSTRAINT school_service_closures_coverage_outcome CHECK (
    (outcome = 'Covered' AND coverage_id IS NOT NULL AND covering_person_id IS NOT NULL)
    OR (outcome = 'Uncovered' AND coverage_id IS NULL AND covering_person_id IS NULL)
  );
ALTER TABLE public.school_service_closures ENABLE TRIGGER school_service_closure_immutable;

CREATE OR REPLACE FUNCTION public.guard_school_service_closure_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  absent_person_id text;
  actual_attendance jsonb;
  current_coverage public.school_service_coverage_records%ROWTYPE;
BEGIN
  SELECT person_id INTO absent_person_id FROM public.school_service_absences WHERE absence_id=NEW.absence_id;
  IF absent_person_id IS NULL OR absent_person_id<>NEW.scheduled_person_id THEN
    RAISE EXCEPTION 'School service closure must retain its absent scheduled person';
  END IF;
  IF NEW.occurrence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.school_service_absences AS absence
    JOIN public.school_service_occurrences AS occurrence
      ON occurrence.proposal_id=absence.proposal_id AND occurrence.department_id=absence.department_id
      AND occurrence.semester_id=absence.semester_id AND occurrence.school_id=absence.school_id
      AND occurrence.day=absence.day AND occurrence.block=absence.block
      AND occurrence.occurred_on=absence.service_date
    WHERE absence.absence_id=NEW.absence_id AND occurrence.occurrence_id=NEW.occurrence_id
  ) THEN RAISE EXCEPTION 'School service closure must reference its exact occurrence'; END IF;
  SELECT decision.attended_person_ids INTO actual_attendance
  FROM public.school_service_absences AS absence
  JOIN public.school_service_decisions AS decision ON decision.commitment_id=absence.commitment_id
  WHERE absence.absence_id=NEW.absence_id AND decision.occurrence_id IS NOT DISTINCT FROM NEW.occurrence_id;
  IF actual_attendance IS NULL OR EXISTS (
    SELECT 1 FROM public.school_service_absences AS absence
    JOIN public.school_service_decisions AS decision ON decision.commitment_id=absence.commitment_id
    WHERE absence.absence_id=NEW.absence_id AND decision.outcome='Cancelled'
  ) THEN RAISE EXCEPTION 'School service closure needs noncancelled terminal decision'; END IF;
  SELECT * INTO current_coverage FROM public.school_service_coverage_records
  WHERE absence_id=NEW.absence_id AND withdrawn_at IS NULL;
  IF NEW.outcome='Covered' AND (
    current_coverage.coverage_id IS DISTINCT FROM NEW.coverage_id
    OR current_coverage.covering_person_id IS DISTINCT FROM NEW.covering_person_id
    OR NOT actual_attendance ? NEW.covering_person_id
  ) THEN RAISE EXCEPTION 'Covered closure must reference its attending current coverage'; END IF;
  IF NEW.outcome='Uncovered' AND current_coverage.coverage_id IS NOT NULL
    AND actual_attendance ? current_coverage.covering_person_id THEN
    RAISE EXCEPTION 'Attending coverage cannot close uncovered';
  END IF;
  RETURN NEW;
END;
$$;

-- Attendance is derived: the confirmed roster minus absent assistants plus current coverage.
CREATE OR REPLACE FUNCTION public.guard_school_service_decision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  service public.school_service_commitments%ROWTYPE;
  derived text[];
  recorded text[];
  actual_count integer;
BEGIN
  SELECT * INTO service FROM public.school_service_commitments WHERE commitment_id=NEW.commitment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commitment not found'; END IF;
  IF NEW.outcome<>'Cancelled' AND (service.service_date+service.end_time) AT TIME ZONE 'Europe/Oslo' > NEW.decided_at THEN
    RAISE EXCEPTION 'Service interval has not ended';
  END IF;
  IF NEW.outcome<>'Cancelled' THEN
    SELECT coalesce(array_agg(DISTINCT people.person_id ORDER BY people.person_id),ARRAY[]::text[])
    INTO derived FROM (
      SELECT assignment->>'personId' AS person_id
      FROM jsonb_array_elements(service.assignment_snapshot) AS assignment
      WHERE NOT EXISTS (
        SELECT 1 FROM public.school_service_absences AS absence
        WHERE absence.commitment_id=NEW.commitment_id AND absence.person_id=assignment->>'personId'
      )
      UNION
      SELECT coverage.covering_person_id
      FROM public.school_service_coverage_records AS coverage
      JOIN public.school_service_absences AS absence USING(absence_id)
      WHERE absence.commitment_id=NEW.commitment_id AND coverage.withdrawn_at IS NULL
    ) AS people;
    SELECT coalesce(array_agg(DISTINCT attendee.person_id ORDER BY attendee.person_id),ARRAY[]::text[])
    INTO recorded FROM jsonb_array_elements_text(NEW.attended_person_ids) AS attendee(person_id);
    IF recorded<>derived THEN
      RAISE EXCEPTION 'Attendance must be the confirmed roster minus absences plus coverage';
    END IF;
  END IF;
  actual_count := jsonb_array_length(NEW.attended_person_ids);
  IF (NEW.outcome='Completed' AND actual_count<service.required_volunteers)
    OR (NEW.outcome='Unfulfilled' AND actual_count>=service.required_volunteers) THEN
    RAISE EXCEPTION 'Attendance does not match outcome';
  END IF;
  RETURN NEW;
END;
$$;

-- The interval index is derived from commitments and coverage, so it is rebuilt with the new
-- source kind instead of being altered. Unresolved offers release their people.
DROP TABLE public.school_service_person_reservations;
CREATE TABLE public.school_service_person_reservations (
  source_id text PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('Scheduled','Coverage')),
  commitment_id text NOT NULL REFERENCES public.school_service_commitments(commitment_id),
  coverage_id text UNIQUE REFERENCES public.school_service_coverage_records(coverage_id),
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  service_date date NOT NULL,
  start_time time(0) NOT NULL,
  end_time time(0) NOT NULL,
  service_interval tsrange GENERATED ALWAYS AS
    (tsrange(service_date+start_time,service_date+end_time,'[)')) STORED,
  CHECK (start_time<end_time),
  CHECK ((source_kind='Scheduled' AND coverage_id IS NULL) OR
    (source_kind='Coverage' AND coverage_id IS NOT NULL AND source_id=coverage_id)),
  CONSTRAINT school_service_person_reservation_no_overlap
    EXCLUDE USING gist (person_id WITH =, service_interval WITH &&)
);
CREATE INDEX school_service_person_reservations_commitment
  ON public.school_service_person_reservations(commitment_id,person_id);
INSERT INTO public.school_service_person_reservations(
  source_id,source_kind,commitment_id,person_id,service_date,start_time,end_time)
SELECT commitment.commitment_id || ':' || (assignment.value->>'personId'),'Scheduled',
  commitment.commitment_id,assignment.value->>'personId',commitment.service_date,
  commitment.start_time,commitment.end_time
FROM public.school_service_commitments AS commitment
CROSS JOIN LATERAL jsonb_array_elements(commitment.assignment_snapshot) AS assignment(value)
WHERE NOT EXISTS (SELECT 1 FROM public.school_service_decisions AS decision
  WHERE decision.commitment_id=commitment.commitment_id AND decision.outcome='Cancelled');
INSERT INTO public.school_service_person_reservations(
  source_id,source_kind,commitment_id,coverage_id,person_id,service_date,start_time,end_time)
SELECT coverage.coverage_id,'Coverage',commitment.commitment_id,coverage.coverage_id,
  coverage.covering_person_id,commitment.service_date,commitment.start_time,commitment.end_time
FROM public.school_service_coverage_records AS coverage
JOIN public.school_service_absences AS absence USING(absence_id)
JOIN public.school_service_commitments AS commitment ON commitment.commitment_id=absence.commitment_id
WHERE coverage.withdrawn_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.school_service_decisions AS decision
    WHERE decision.commitment_id=commitment.commitment_id AND decision.outcome='Cancelled');
CREATE TRIGGER school_service_person_reservation_guard
  BEFORE UPDATE OR DELETE ON public.school_service_person_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_person_reservation_change();

CREATE FUNCTION public.reserve_school_service_coverage_person() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  service public.school_service_commitments%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.withdrawn_at IS NOT NULL AND OLD.withdrawn_at IS NULL THEN
      DELETE FROM public.school_service_person_reservations
      WHERE source_kind='Coverage' AND coverage_id=NEW.coverage_id;
    END IF;
    RETURN NEW;
  END IF;
  SELECT commitment.* INTO service
  FROM public.school_service_absences AS absence
  JOIN public.school_service_commitments AS commitment
    ON commitment.commitment_id=absence.commitment_id
  WHERE absence.absence_id=NEW.absence_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'School service coverage requires a dated commitment'; END IF;
  INSERT INTO public.school_service_person_reservations(
    source_id,source_kind,commitment_id,coverage_id,person_id,service_date,start_time,end_time)
  VALUES(NEW.coverage_id,'Coverage',service.commitment_id,NEW.coverage_id,NEW.covering_person_id,
    service.service_date,service.start_time,service.end_time);
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_coverage_live_guard
  BEFORE INSERT OR UPDATE ON public.school_service_coverage_records
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_live_coverage();
CREATE TRIGGER school_service_coverage_reserve_person
  AFTER INSERT OR UPDATE ON public.school_service_coverage_records
  FOR EACH ROW EXECUTE FUNCTION public.reserve_school_service_coverage_person();

-- The offer and dispatch flow ends here; its tables take their triggers with them.
DROP TABLE public.school_service_dispatch_notification_outbox;
DROP TABLE public.school_service_substitute_offer_responses;
DROP TABLE public.school_service_substitute_offer_withdrawals;
DROP TABLE public.school_service_coverage_acknowledgements;
DROP TABLE public.school_service_substitute_offers;
DROP FUNCTION public.reserve_school_service_offer_person();
DROP FUNCTION public.guard_school_service_substitute_offer();
DROP FUNCTION public.guard_school_service_dispatch_notification();
DROP FUNCTION public.guard_school_service_offer_response_insert();
DROP FUNCTION public.guard_school_service_offer_withdrawal_insert();
DROP FUNCTION public.guard_school_service_acknowledgement_insert();

-- The immutable audit keeps its historical offer actions readable.
ALTER TABLE public.school_service_coverage_audit DROP CONSTRAINT school_service_coverage_audit_action_check;
ALTER TABLE public.school_service_coverage_audit ADD CONSTRAINT school_service_coverage_audit_action_check
  CHECK (action IN ('ReportAbsence','RecordCoverage','WithdrawCoverage','CompleteService',
    'CancelService','MarkUnfulfilledService','DispatchSubstituteOffer','RespondToOffer',
    'WithdrawSubstituteOffer','AcknowledgeCoverage','CloseCoverage'));

-- The substitute pool ends with it.
DROP TABLE public.admission_substitute_preferences;
