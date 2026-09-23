-- A confirmed proposal's dated service is an immutable snapshot. Earlier unlinked
-- occurrences and absences remain historical; only new rows require a commitment.
CREATE TABLE public.school_service_commitments (
  commitment_id text PRIMARY KEY CHECK (commitment_id ~ '^school-service-commitment-[a-f0-9]{64}$'),
  proposal_id text NOT NULL,
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  school_id bigint NOT NULL,
  school_name text NOT NULL,
  day text NOT NULL CHECK (day IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
  block text NOT NULL CHECK (block IN ('1','2')),
  service_date date NOT NULL,
  start_time time(0) without time zone NOT NULL,
  end_time time(0) without time zone NOT NULL,
  required_volunteers integer NOT NULL CHECK (required_volunteers > 0),
  assignment_snapshot jsonb NOT NULL CHECK (jsonb_typeof(assignment_snapshot) = 'array'),
  created_at timestamptz NOT NULL,
  created_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  CHECK (start_time < end_time),
  CONSTRAINT school_service_commitment_slot_unique UNIQUE (department_id,school_id,service_date,block),
  UNIQUE (commitment_id,proposal_id,department_id,semester_id,school_id,day,block,service_date),
  FOREIGN KEY (proposal_id,department_id,semester_id)
    REFERENCES public.school_service_proposals(proposal_id,department_id,semester_id),
  FOREIGN KEY (school_id,department_id)
    REFERENCES public.schools_directory_departments(school_id,department_id)
);
CREATE INDEX school_service_commitments_scope_date ON public.school_service_commitments(department_id,semester_id,service_date,commitment_id);

CREATE FUNCTION public.guard_school_service_commitment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proposal public.school_service_proposals%ROWTYPE;
  snapshot_demand integer;
BEGIN
  SELECT * INTO proposal FROM public.school_service_proposals WHERE proposal_id=NEW.proposal_id FOR SHARE;
  IF NOT FOUND OR proposal.status<>'Confirmed' THEN RAISE EXCEPTION 'Confirmed proposal required'; END IF;
  SELECT (demand->>'requiredVolunteers')::integer INTO snapshot_demand
  FROM jsonb_array_elements(proposal.demand_snapshot) AS demand
  WHERE (demand->>'schoolId')::bigint=NEW.school_id
    AND demand->>'day'=NEW.day AND demand->>'block'=NEW.block;
  IF snapshot_demand IS NULL OR snapshot_demand<>NEW.required_volunteers OR
    NEW.assignment_snapshot<>(SELECT coalesce(jsonb_agg(assignment),'[]'::jsonb)
      FROM jsonb_array_elements(proposal.assignment_snapshot) AS assignment
      WHERE (assignment->>'schoolId')::bigint=NEW.school_id
        AND assignment->>'day'=NEW.day AND assignment->>'block'=NEW.block) THEN
    RAISE EXCEPTION 'Commitment does not match confirmed proposal snapshot';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admission_period_semesters
    WHERE semester_id=NEW.semester_id AND NEW.service_date BETWEEN start_at::date AND end_at::date)
    OR to_char(NEW.service_date,'FMDay')<>NEW.day THEN
    RAISE EXCEPTION 'Service date outside semester or weekday mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.school_service_occurrences
      WHERE department_id=NEW.department_id AND school_id=NEW.school_id
        AND occurred_on=NEW.service_date AND block=NEW.block)
    OR EXISTS (SELECT 1 FROM public.school_service_absences
      WHERE department_id=NEW.department_id AND school_id=NEW.school_id
        AND service_date=NEW.service_date AND block=NEW.block) THEN
    RAISE EXCEPTION 'Historical service already exists for slot';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_commitment_insert_guard BEFORE INSERT ON public.school_service_commitments
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_commitment_insert();

CREATE FUNCTION public.guard_school_service_commitment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'School service commitment snapshot is immutable';
END;
$$;
CREATE TRIGGER school_service_commitment_immutable
  BEFORE UPDATE OR DELETE ON public.school_service_commitments
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_commitment();

CREATE TABLE public.school_service_decisions (
  commitment_id text PRIMARY KEY REFERENCES public.school_service_commitments(commitment_id),
  outcome text NOT NULL CHECK (outcome IN ('Completed','Cancelled','Unfulfilled')),
  decided_at timestamptz NOT NULL,
  decided_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  evidence_source text NOT NULL CHECK (length(evidence_source) <= 500 AND length(btrim(evidence_source)) > 0),
  reason text CHECK (reason IS NULL OR (length(reason) <= 500 AND length(btrim(reason)) > 0)),
  attended_person_ids jsonb NOT NULL CHECK (public.school_service_attendee_ids_unique(attended_person_ids)),
  occurrence_id text UNIQUE,
  CHECK ((outcome='Cancelled' AND reason IS NOT NULL AND attended_person_ids='[]'::jsonb AND occurrence_id IS NULL)
      OR (outcome='Completed' AND reason IS NULL AND occurrence_id IS NOT NULL)
      OR (outcome='Unfulfilled' AND reason IS NOT NULL AND
          ((jsonb_array_length(attended_person_ids)=0 AND occurrence_id IS NULL) OR
           (jsonb_array_length(attended_person_ids)>0 AND occurrence_id IS NOT NULL))))
);
CREATE TRIGGER school_service_decision_immutable
  BEFORE UPDATE OR DELETE ON public.school_service_decisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_commitment();

ALTER TABLE public.school_service_absences ADD COLUMN commitment_id text;
ALTER TABLE public.school_service_occurrences ADD COLUMN commitment_id text UNIQUE;
ALTER TABLE public.school_service_closures ALTER COLUMN occurrence_id DROP NOT NULL;
ALTER TABLE public.school_service_absences
  ADD CONSTRAINT school_service_absence_commitment_scope FOREIGN KEY
    (commitment_id,proposal_id,department_id,semester_id,school_id,day,block,service_date)
    REFERENCES public.school_service_commitments
    (commitment_id,proposal_id,department_id,semester_id,school_id,day,block,service_date);
ALTER TABLE public.school_service_occurrences
  ADD CONSTRAINT school_service_occurrence_commitment_scope FOREIGN KEY
    (commitment_id,proposal_id,department_id,semester_id,school_id,day,block,occurred_on)
    REFERENCES public.school_service_commitments
    (commitment_id,proposal_id,department_id,semester_id,school_id,day,block,service_date);
ALTER TABLE public.school_service_occurrences
  ADD CONSTRAINT school_service_occurrence_has_attendance CHECK
    (commitment_id IS NULL OR jsonb_array_length(attended_person_ids)>0);
ALTER TABLE public.school_service_decisions
  ADD CONSTRAINT school_service_decision_occurrence_ref FOREIGN KEY (occurrence_id)
    REFERENCES public.school_service_occurrences(occurrence_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.school_service_audit DROP CONSTRAINT school_service_audit_action_check;
ALTER TABLE public.school_service_audit ADD CONSTRAINT school_service_audit_action_check
  CHECK (action IN ('SetDemand','RemoveDemand','GenerateProposal','ConfirmProposal','RecordOccurrence','ScheduleService'));
ALTER TABLE public.school_service_coverage_audit DROP CONSTRAINT school_service_coverage_audit_action_check;
ALTER TABLE public.school_service_coverage_audit ADD CONSTRAINT school_service_coverage_audit_action_check
  CHECK (action IN ('ReportAbsence','DispatchSubstituteOffer','RespondToOffer','WithdrawSubstituteOffer','AcknowledgeCoverage','CloseCoverage','CompleteService','CancelService','MarkUnfulfilledService'));

CREATE FUNCTION public.guard_school_service_decision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  service public.school_service_commitments%ROWTYPE;
  eligible text[];
  actual_count integer;
BEGIN
  SELECT * INTO service FROM public.school_service_commitments WHERE commitment_id=NEW.commitment_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commitment not found'; END IF;
  IF NEW.outcome<>'Cancelled' AND (service.service_date+service.end_time) AT TIME ZONE 'Europe/Oslo' > NEW.decided_at THEN
    RAISE EXCEPTION 'Service interval has not ended';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.school_service_substitute_offers AS offer
    JOIN public.school_service_absences AS absence USING(absence_id)
    WHERE absence.commitment_id=NEW.commitment_id AND offer.status IN ('Offered','Accepted')
  ) THEN RAISE EXCEPTION 'Pending substitute offer'; END IF;
  SELECT coalesce(array_agg(DISTINCT person_id),ARRAY[]::text[]) INTO eligible FROM (
    SELECT assignment->>'personId' AS person_id
    FROM jsonb_array_elements(service.assignment_snapshot) AS assignment
    WHERE NOT EXISTS (
      SELECT 1 FROM public.school_service_absences AS absence
      WHERE absence.commitment_id=NEW.commitment_id AND absence.person_id=assignment->>'personId'
    )
    UNION
    SELECT acknowledgement.candidate_person_id
    FROM public.school_service_coverage_acknowledgements AS acknowledgement
    JOIN public.school_service_absences AS absence USING(absence_id)
    WHERE absence.commitment_id=NEW.commitment_id
  ) AS people;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW.attended_person_ids) AS attendee(person_id)
    WHERE NOT (attendee.person_id=ANY(eligible))) THEN
    RAISE EXCEPTION 'Attendance includes ineligible person';
  END IF;
  actual_count := jsonb_array_length(NEW.attended_person_ids);
  IF (NEW.outcome='Completed' AND actual_count<service.required_volunteers)
    OR (NEW.outcome='Unfulfilled' AND actual_count>=service.required_volunteers) THEN
    RAISE EXCEPTION 'Attendance does not match outcome';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_decision_insert_guard
  BEFORE INSERT ON public.school_service_decisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_decision_insert();

CREATE FUNCTION public.guard_school_service_live_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  linked_commitment text;
BEGIN
  IF TG_TABLE_NAME='school_service_absences' THEN
    linked_commitment := NEW.commitment_id;
  ELSE
    SELECT absence.commitment_id INTO linked_commitment
    FROM public.school_service_absences AS absence WHERE absence.absence_id=NEW.absence_id;
  END IF;
  IF linked_commitment IS NULL THEN RAISE EXCEPTION 'New coverage requires a dated commitment'; END IF;
  IF EXISTS (SELECT 1 FROM public.school_service_decisions WHERE commitment_id=linked_commitment) THEN
    RAISE EXCEPTION 'Terminal school service cannot change coverage';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_absence_live_guard BEFORE INSERT ON public.school_service_absences
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_live_coverage();
CREATE TRIGGER school_service_offer_live_guard BEFORE INSERT OR UPDATE ON public.school_service_substitute_offers
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_live_coverage();
CREATE TRIGGER school_service_response_live_guard BEFORE INSERT ON public.school_service_substitute_offer_responses
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_live_coverage();
CREATE TRIGGER school_service_withdrawal_live_guard BEFORE INSERT ON public.school_service_substitute_offer_withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_live_coverage();
CREATE TRIGGER school_service_acknowledgement_live_guard BEFORE INSERT ON public.school_service_coverage_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_live_coverage();

CREATE OR REPLACE FUNCTION public.guard_school_service_closure_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  absent_person_id text;
  actual_attendance jsonb;
BEGIN
  SELECT person_id INTO absent_person_id FROM public.school_service_absences WHERE absence_id=NEW.absence_id;
  IF absent_person_id IS NULL OR absent_person_id<>NEW.scheduled_person_id THEN
    RAISE EXCEPTION 'School service closure must retain its absent scheduled person';
  END IF;
  IF EXISTS (SELECT 1 FROM public.school_service_substitute_offers
    WHERE absence_id=NEW.absence_id AND status IN ('Offered','Accepted')) THEN
    RAISE EXCEPTION 'School service closure cannot leave an unresolved offer';
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
  IF NEW.outcome='Covered' AND NOT EXISTS (
    SELECT 1 FROM public.school_service_coverage_acknowledgements
    WHERE acknowledgement_id=NEW.acknowledgement_id AND absence_id=NEW.absence_id
      AND candidate_person_id=NEW.substitute_person_id
  ) THEN RAISE EXCEPTION 'Covered closure must reference its acknowledgement'; END IF;
  IF NEW.outcome='Covered' AND NOT actual_attendance ? NEW.substitute_person_id THEN
    RAISE EXCEPTION 'Covered substitute did not attend';
  END IF;
  IF NEW.outcome='Uncovered' AND EXISTS (
    SELECT 1 FROM public.school_service_coverage_acknowledgements
    WHERE absence_id=NEW.absence_id AND actual_attendance ? candidate_person_id
  ) THEN RAISE EXCEPTION 'Attending acknowledged substitute cannot close uncovered'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.guard_school_service_occurrence_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.commitment_id IS NULL THEN RAISE EXCEPTION 'New occurrence requires dated commitment'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.school_service_decisions
    WHERE commitment_id=NEW.commitment_id AND occurrence_id=NEW.occurrence_id
      AND attended_person_ids=NEW.attended_person_ids AND outcome IN ('Completed','Unfulfilled')) THEN
    RAISE EXCEPTION 'Occurrence must match terminal attendance';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_occurrence_insert_guard BEFORE INSERT ON public.school_service_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_occurrence_insert();
