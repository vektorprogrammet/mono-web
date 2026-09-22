-- 0111: immutable absence, sequential substitute coverage, and atomic service closure.
CREATE FUNCTION public.school_service_attendee_ids_unique(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(value) = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(value) AS attendee(person_id)
      GROUP BY attendee.person_id
      HAVING count(*) > 1
    )
$$;

ALTER TABLE public.school_service_occurrences
  ADD CONSTRAINT school_service_occurrences_attendees_unique
  CHECK (public.school_service_attendee_ids_unique(attended_person_ids)) NOT VALID;

CREATE TABLE public.school_service_absences (
  absence_id text PRIMARY KEY
    CHECK (absence_id ~ '^school-service-absence-[a-f0-9]{64}$'),
  proposal_id text NOT NULL,
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  school_id bigint NOT NULL,
  day text NOT NULL CHECK (day IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
  block text NOT NULL CHECK (block IN ('1','2')),
  service_date date NOT NULL,
  reporter_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  reported_at timestamptz NOT NULL,
  UNIQUE (absence_id, proposal_id, department_id, semester_id),
  CONSTRAINT school_service_absence_target_unique
    UNIQUE (proposal_id, school_id, day, block, service_date, person_id),
  FOREIGN KEY (proposal_id, department_id, semester_id)
    REFERENCES public.school_service_proposals(proposal_id, department_id, semester_id),
  FOREIGN KEY (school_id, department_id)
    REFERENCES public.schools_directory_departments(school_id, department_id)
);
CREATE INDEX school_service_absences_scope_slot
  ON public.school_service_absences(department_id, semester_id, proposal_id, school_id, day, block, service_date);

CREATE TABLE public.school_service_substitute_offers (
  offer_id text PRIMARY KEY
    CHECK (offer_id ~ '^school-service-substitute-offer-[a-f0-9]{64}$'),
  absence_id text NOT NULL REFERENCES public.school_service_absences(absence_id),
  candidate_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  dispatcher_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  dispatched_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'Offered'
    CHECK (status IN ('Offered','Accepted','Declined','Withdrawn','Acknowledged')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  eligibility_snapshot jsonb NOT NULL CHECK (jsonb_typeof(eligibility_snapshot) = 'object'),
  UNIQUE (offer_id, absence_id),
);
-- State values other than Offered, Accepted and Acknowledged may recur; only the
-- currently unresolved or accepted path is unique per absence.
CREATE UNIQUE INDEX school_service_substitute_offer_active_partial_unique
  ON public.school_service_substitute_offers(absence_id)
  WHERE status IN ('Offered','Accepted','Acknowledged');
CREATE UNIQUE INDEX school_service_substitute_offer_accepted_partial_unique
  ON public.school_service_substitute_offers(absence_id)
  WHERE status IN ('Accepted','Acknowledged');
CREATE INDEX school_service_substitute_offers_candidate
  ON public.school_service_substitute_offers(candidate_person_id, dispatched_at DESC, offer_id DESC);

CREATE TABLE public.school_service_substitute_offer_responses (
  offer_id text PRIMARY KEY,
  absence_id text NOT NULL,
  response text NOT NULL CHECK (response IN ('Accept','Decline')),
  responder_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  responded_at timestamptz NOT NULL,
  FOREIGN KEY (offer_id, absence_id)
    REFERENCES public.school_service_substitute_offers(offer_id, absence_id)
);

CREATE TABLE public.school_service_substitute_offer_withdrawals (
  offer_id text PRIMARY KEY,
  absence_id text NOT NULL,
  withdrawn_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  withdrawn_at timestamptz NOT NULL,
  FOREIGN KEY (offer_id, absence_id)
    REFERENCES public.school_service_substitute_offers(offer_id, absence_id)
);

CREATE TABLE public.school_service_coverage_acknowledgements (
  acknowledgement_id text PRIMARY KEY
    CHECK (acknowledgement_id ~ '^school-service-coverage-acknowledgement-[a-f0-9]{64}$'),
  offer_id text NOT NULL UNIQUE,
  absence_id text NOT NULL,
  candidate_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  acknowledged_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  acknowledged_at timestamptz NOT NULL,
  UNIQUE (acknowledgement_id, absence_id),
  FOREIGN KEY (offer_id, absence_id)
    REFERENCES public.school_service_substitute_offers(offer_id, absence_id)
);

CREATE TABLE public.school_service_dispatch_notification_outbox (
  effect_id text PRIMARY KEY
    CHECK (effect_id ~ '^school-service-substitute-dispatch:school-service-substitute-offer-[a-f0-9]{64}$'),
  offer_id text NOT NULL UNIQUE REFERENCES public.school_service_substitute_offers(offer_id),
  absence_id text NOT NULL REFERENCES public.school_service_absences(absence_id),
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  status text NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending','Processing','Delivered','Failed','Quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_id text,
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_failure_tag text,
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  CHECK (
    (status = 'Processing' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'Processing' AND claim_id IS NULL AND claimed_at IS NULL)
  ),
  CHECK (
    (status = 'Delivered' AND delivered_at IS NOT NULL)
    OR (status <> 'Delivered' AND delivered_at IS NULL)
  )
);
CREATE INDEX school_service_dispatch_notification_pending
  ON public.school_service_dispatch_notification_outbox(status, attempts, effect_id);

CREATE TABLE public.school_service_closures (
  closure_id text PRIMARY KEY
    CHECK (closure_id ~ '^school-service-closure-[a-f0-9]{64}$'),
  absence_id text NOT NULL UNIQUE REFERENCES public.school_service_absences(absence_id),
  occurrence_id text NOT NULL REFERENCES public.school_service_occurrences(occurrence_id),
  scheduled_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  outcome text NOT NULL CHECK (outcome IN ('Covered','Uncovered')),
  acknowledgement_id text,
  substitute_person_id text REFERENCES public.person_profiles(person_id),
  closed_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  closed_at timestamptz NOT NULL,
  FOREIGN KEY (acknowledgement_id, absence_id)
    REFERENCES public.school_service_coverage_acknowledgements(acknowledgement_id, absence_id),
  CHECK (
    (outcome = 'Covered' AND acknowledgement_id IS NOT NULL AND substitute_person_id IS NOT NULL)
    OR (outcome = 'Uncovered' AND acknowledgement_id IS NULL AND substitute_person_id IS NULL)
  )
);
CREATE INDEX school_service_closures_occurrence
  ON public.school_service_closures(occurrence_id, closure_id);

CREATE TABLE public.school_service_coverage_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  action text NOT NULL CHECK (action IN (
    'ReportAbsence',
    'DispatchSubstituteOffer',
    'RespondToOffer',
    'WithdrawSubstituteOffer',
    'AcknowledgeCoverage',
    'CloseCoverage'
  )),
  occurred_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object')
);
CREATE INDEX school_service_coverage_audit_scope_order
  ON public.school_service_coverage_audit(department_id, semester_id, audit_id);

CREATE FUNCTION public.guard_school_service_absence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'School service absence is immutable';
END;
$$;
CREATE TRIGGER school_service_absence_immutable
  BEFORE UPDATE OR DELETE ON public.school_service_absences
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_absence();

CREATE FUNCTION public.guard_school_service_substitute_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'School service substitute offer is immutable';
  END IF;
  IF NEW.offer_id IS DISTINCT FROM OLD.offer_id
    OR NEW.absence_id IS DISTINCT FROM OLD.absence_id
    OR NEW.candidate_person_id IS DISTINCT FROM OLD.candidate_person_id
    OR NEW.dispatcher_person_id IS DISTINCT FROM OLD.dispatcher_person_id
    OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at
    OR NEW.eligibility_snapshot IS DISTINCT FROM OLD.eligibility_snapshot THEN
    RAISE EXCEPTION 'School service substitute offer identity is immutable';
  END IF;
  IF OLD.status = 'Offered'
    AND NEW.status IN ('Accepted','Declined','Withdrawn')
    AND NEW.revision = OLD.revision + 1 THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'Accepted'
    AND NEW.status IN ('Withdrawn','Acknowledged')
    AND NEW.revision = OLD.revision + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'School service substitute offer transition is invalid';
END;
$$;
CREATE TRIGGER school_service_substitute_offer_guard
  BEFORE UPDATE OR DELETE ON public.school_service_substitute_offers
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_substitute_offer();

CREATE FUNCTION public.guard_school_service_dispatch_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effect_id IS DISTINCT FROM OLD.effect_id
    OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
    OR NEW.absence_id IS DISTINCT FROM OLD.absence_id
    OR NEW.person_id IS DISTINCT FROM OLD.person_id
    OR NEW.payload_json IS DISTINCT FROM OLD.payload_json THEN
    RAISE EXCEPTION 'School service dispatch notification identity and payload are immutable';
  END IF;
  IF OLD.status IN ('Delivered','Quarantined') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal school service dispatch notification is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_dispatch_notification_guard
  BEFORE UPDATE ON public.school_service_dispatch_notification_outbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_dispatch_notification();

CREATE FUNCTION public.guard_school_service_offer_response_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
  current_candidate text;
  current_absence text;
BEGIN
  SELECT status,candidate_person_id,absence_id
    INTO current_status,current_candidate,current_absence
    FROM public.school_service_substitute_offers
    WHERE offer_id=NEW.offer_id;
  IF current_absence IS NULL
    OR current_absence <> NEW.absence_id
    OR current_candidate <> NEW.responder_person_id
    OR (NEW.response='Accept' AND current_status<>'Accepted')
    OR (NEW.response='Decline' AND current_status<>'Declined') THEN
    RAISE EXCEPTION 'School service offer response must match its terminal transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_offer_response_insert_guard
  BEFORE INSERT ON public.school_service_substitute_offer_responses
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_offer_response_insert();

CREATE FUNCTION public.guard_school_service_offer_withdrawal_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
  current_absence text;
BEGIN
  SELECT status,absence_id INTO current_status,current_absence
    FROM public.school_service_substitute_offers
    WHERE offer_id=NEW.offer_id;
  IF current_absence IS NULL OR current_absence<>NEW.absence_id OR current_status<>'Withdrawn' THEN
    RAISE EXCEPTION 'School service offer withdrawal must match its transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_offer_withdrawal_insert_guard
  BEFORE INSERT ON public.school_service_substitute_offer_withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_offer_withdrawal_insert();

CREATE FUNCTION public.guard_school_service_acknowledgement_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
  current_candidate text;
  current_absence text;
BEGIN
  SELECT status,candidate_person_id,absence_id
    INTO current_status,current_candidate,current_absence
    FROM public.school_service_substitute_offers
    WHERE offer_id=NEW.offer_id;
  IF current_absence IS NULL
    OR current_absence<>NEW.absence_id
    OR current_candidate<>NEW.candidate_person_id
    OR current_status<>'Acknowledged'
    OR NOT EXISTS (
      SELECT 1 FROM public.school_service_substitute_offer_responses
      WHERE offer_id=NEW.offer_id AND response='Accept'
    ) THEN
    RAISE EXCEPTION 'School service acknowledgement must match an accepted offer';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_acknowledgement_insert_guard
  BEFORE INSERT ON public.school_service_coverage_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_acknowledgement_insert();

CREATE FUNCTION public.guard_school_service_closure_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  absent_person_id text;
BEGIN
  SELECT person_id INTO absent_person_id
    FROM public.school_service_absences
    WHERE absence_id=NEW.absence_id;
  IF absent_person_id IS NULL OR absent_person_id<>NEW.scheduled_person_id THEN
    RAISE EXCEPTION 'School service closure must retain its absent scheduled person';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.school_service_substitute_offers
    WHERE absence_id=NEW.absence_id AND status IN ('Offered','Accepted')
  ) THEN
    RAISE EXCEPTION 'School service closure cannot leave an unresolved offer';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.school_service_absences AS absence
    JOIN public.school_service_occurrences AS occurrence
      ON occurrence.proposal_id=absence.proposal_id
      AND occurrence.department_id=absence.department_id
      AND occurrence.semester_id=absence.semester_id
      AND occurrence.school_id=absence.school_id
      AND occurrence.day=absence.day
      AND occurrence.block=absence.block
      AND occurrence.occurred_on=absence.service_date
    WHERE absence.absence_id=NEW.absence_id
      AND occurrence.occurrence_id=NEW.occurrence_id
  ) THEN
    RAISE EXCEPTION 'School service closure must reference its exact occurrence';
  END IF;
  IF NEW.outcome='Covered' AND NOT EXISTS (
    SELECT 1 FROM public.school_service_coverage_acknowledgements
    WHERE acknowledgement_id=NEW.acknowledgement_id
      AND absence_id=NEW.absence_id
      AND candidate_person_id=NEW.substitute_person_id
  ) THEN
    RAISE EXCEPTION 'Covered school service closure must reference its acknowledgement';
  END IF;
  IF NEW.outcome='Uncovered' AND EXISTS (
    SELECT 1 FROM public.school_service_coverage_acknowledgements
    WHERE absence_id=NEW.absence_id
  ) THEN
    RAISE EXCEPTION 'Acknowledged school service coverage cannot close uncovered';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_closure_insert_guard
  BEFORE INSERT ON public.school_service_closures
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_closure_insert();

CREATE FUNCTION public.prevent_school_service_coverage_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'School service coverage history is immutable';
END;
$$;
CREATE TRIGGER school_service_substitute_offer_response_immutable
  BEFORE UPDATE OR DELETE ON public.school_service_substitute_offer_responses
  FOR EACH ROW EXECUTE FUNCTION public.prevent_school_service_coverage_history_mutation();
CREATE TRIGGER school_service_substitute_offer_withdrawal_immutable
  BEFORE UPDATE OR DELETE ON public.school_service_substitute_offer_withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.prevent_school_service_coverage_history_mutation();
CREATE TRIGGER school_service_coverage_acknowledgement_immutable
  BEFORE UPDATE OR DELETE ON public.school_service_coverage_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION public.prevent_school_service_coverage_history_mutation();
CREATE TRIGGER school_service_closure_immutable
  BEFORE UPDATE OR DELETE ON public.school_service_closures
  FOR EACH ROW EXECUTE FUNCTION public.prevent_school_service_coverage_history_mutation();
CREATE TRIGGER school_service_coverage_audit_immutable
  BEFORE UPDATE OR DELETE ON public.school_service_coverage_audit
  FOR EACH ROW EXECUTE FUNCTION public.prevent_school_service_coverage_history_mutation();
