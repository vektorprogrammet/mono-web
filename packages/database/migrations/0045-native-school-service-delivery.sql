CREATE TABLE public.school_service_demand (
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  school_id bigint NOT NULL,
  day text NOT NULL CHECK(day IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
  block text NOT NULL CHECK(block IN ('1','2')),
  required_volunteers integer NOT NULL CHECK(required_volunteers > 0),
  revision integer NOT NULL CHECK(revision > 0),
  PRIMARY KEY(department_id,semester_id,school_id,day,block),
  FOREIGN KEY(school_id,department_id)
    REFERENCES public.schools_directory_departments(school_id,department_id)
);

CREATE TABLE public.school_service_proposals (
  proposal_id text PRIMARY KEY CHECK(proposal_id ~ '^school-service-proposal-[a-f0-9]{64}$'),
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  status text NOT NULL CHECK(status IN ('Draft','Confirmed')),
  revision integer NOT NULL CHECK(revision > 0),
  created_at timestamptz NOT NULL,
  created_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  confirmed_at timestamptz,
  confirmed_by_person_id text REFERENCES public.person_profiles(person_id),
  demand_snapshot jsonb NOT NULL CHECK(jsonb_typeof(demand_snapshot)='array'),
  assignment_snapshot jsonb NOT NULL CHECK(jsonb_typeof(assignment_snapshot)='array'),
  exception_snapshot jsonb NOT NULL CHECK(jsonb_typeof(exception_snapshot)='array'),
  reviewed_exception_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(reviewed_exception_ids)='array'),
  CHECK((status='Draft' AND confirmed_at IS NULL AND confirmed_by_person_id IS NULL)
    OR (status='Confirmed' AND confirmed_at IS NOT NULL AND confirmed_by_person_id IS NOT NULL)),
  UNIQUE(proposal_id,department_id,semester_id)
);
CREATE INDEX school_service_proposals_scope_order
  ON public.school_service_proposals(department_id,semester_id,created_at DESC,proposal_id DESC);

CREATE FUNCTION public.guard_school_service_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.department_id IS DISTINCT FROM OLD.department_id
    OR NEW.semester_id IS DISTINCT FROM OLD.semester_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id
    OR NEW.demand_snapshot IS DISTINCT FROM OLD.demand_snapshot
    OR NEW.assignment_snapshot IS DISTINCT FROM OLD.assignment_snapshot
    OR NEW.exception_snapshot IS DISTINCT FROM OLD.exception_snapshot THEN
    RAISE EXCEPTION 'School service proposal snapshot is immutable';
  END IF;
  IF OLD.status = 'Confirmed' THEN
    RAISE EXCEPTION 'Confirmed school service proposal is immutable';
  END IF;
  IF NEW.status <> 'Confirmed' OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'School service proposal permits only one confirmation transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_proposal_guard
  BEFORE UPDATE ON public.school_service_proposals
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_proposal();

CREATE TABLE public.school_service_notification_outbox (
  effect_id text PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES public.school_service_proposals(proposal_id),
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  status text NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Processing','Delivered','Failed','Quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  claim_id text,
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_failure_tag text,
  payload_json jsonb NOT NULL CHECK(jsonb_typeof(payload_json)='object'),
  UNIQUE(proposal_id,person_id),
  CHECK((status='Processing' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status<>'Processing' AND claim_id IS NULL AND claimed_at IS NULL)),
  CHECK((status='Delivered' AND delivered_at IS NOT NULL)
    OR (status<>'Delivered' AND delivered_at IS NULL))
);
CREATE INDEX school_service_notification_pending
  ON public.school_service_notification_outbox(status,attempts,effect_id);

CREATE FUNCTION public.guard_school_service_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
    OR NEW.person_id IS DISTINCT FROM OLD.person_id
    OR NEW.payload_json IS DISTINCT FROM OLD.payload_json THEN
    RAISE EXCEPTION 'School service notification identity and payload are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_notification_guard
  BEFORE UPDATE ON public.school_service_notification_outbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_notification();

CREATE TABLE public.school_service_occurrences (
  occurrence_id text PRIMARY KEY CHECK(occurrence_id ~ '^school-service-occurrence-[a-f0-9]{64}$'),
  proposal_id text NOT NULL,
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  school_id bigint NOT NULL REFERENCES public.schools_directory_schools(school_id),
  day text NOT NULL CHECK(day IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
  block text NOT NULL CHECK(block IN ('1','2')),
  occurred_on date NOT NULL,
  attended_person_ids jsonb NOT NULL CHECK(jsonb_typeof(attended_person_ids)='array'),
  recorded_at timestamptz NOT NULL,
  recorded_by_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  UNIQUE(proposal_id,school_id,day,block,occurred_on),
  FOREIGN KEY(proposal_id,department_id,semester_id)
    REFERENCES public.school_service_proposals(proposal_id,department_id,semester_id),
  FOREIGN KEY(school_id,department_id)
    REFERENCES public.schools_directory_departments(school_id,department_id)
);

CREATE FUNCTION public.reject_school_service_occurrence_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'School service occurrence is immutable';
END;
$$;
CREATE TRIGGER school_service_occurrence_immutable
  BEFORE UPDATE OR DELETE ON public.school_service_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.reject_school_service_occurrence_update();

CREATE TABLE public.school_service_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id text NOT NULL,
  semester_id text NOT NULL,
  actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  action text NOT NULL CHECK(action IN ('SetDemand','RemoveDemand','GenerateProposal','ConfirmProposal','RecordOccurrence')),
  occurred_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object')
);
CREATE INDEX school_service_audit_scope_order
  ON public.school_service_audit(department_id,semester_id,audit_id);
