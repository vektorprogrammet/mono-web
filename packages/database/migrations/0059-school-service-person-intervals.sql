-- Additive repair to the immutable dated-service contract already installed by 0058.
ALTER TABLE public.school_service_decisions DROP CONSTRAINT school_service_decision_occurrence_ref;
ALTER TABLE public.school_service_occurrences
  ADD CONSTRAINT school_service_occurrence_commitment_identity UNIQUE (occurrence_id,commitment_id);
ALTER TABLE public.school_service_decisions
  ADD CONSTRAINT school_service_decision_occurrence_ref FOREIGN KEY (occurrence_id,commitment_id)
  REFERENCES public.school_service_occurrences(occurrence_id,commitment_id) DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION public.guard_school_service_decision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  service public.school_service_commitments%ROWTYPE;
  eligible text[];
  actual_count integer;
BEGIN
  SELECT * INTO service FROM public.school_service_commitments WHERE commitment_id=NEW.commitment_id FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.guard_school_service_live_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
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
  PERFORM 1 FROM public.school_service_commitments WHERE commitment_id=linked_commitment FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.school_service_decisions WHERE commitment_id=linked_commitment) THEN
    RAISE EXCEPTION 'Terminal school service cannot change coverage';
  END IF;
  RETURN NEW;
END;
$$;

/* One derived interval claim per scheduled assistant or live substitute offer. */
/* The source commitment/offer remains authoritative; triggers maintain this index. */
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE public.school_service_person_reservations (
  source_id text PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('Scheduled','Offer')),
  commitment_id text NOT NULL REFERENCES public.school_service_commitments(commitment_id),
  offer_id text UNIQUE REFERENCES public.school_service_substitute_offers(offer_id),
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  service_date date NOT NULL,
  start_time time(0) NOT NULL,
  end_time time(0) NOT NULL,
  service_interval tsrange GENERATED ALWAYS AS
    (tsrange(service_date+start_time,service_date+end_time,'[)')) STORED,
  CHECK (start_time<end_time),
  CHECK ((source_kind='Scheduled' AND offer_id IS NULL) OR
    (source_kind='Offer' AND offer_id IS NOT NULL)),
  CONSTRAINT school_service_person_reservation_no_overlap
    EXCLUDE USING gist (person_id WITH =, service_interval WITH &&)
);
CREATE INDEX school_service_person_reservations_commitment
  ON public.school_service_person_reservations(commitment_id,person_id);

CREATE FUNCTION public.reserve_school_service_commitment_people() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.school_service_person_reservations(
    source_id,source_kind,commitment_id,person_id,service_date,start_time,end_time)
  SELECT NEW.commitment_id || ':' || (assignment.value->>'personId'),'Scheduled',NEW.commitment_id,
    assignment.value->>'personId',NEW.service_date,NEW.start_time,NEW.end_time
  FROM jsonb_array_elements(NEW.assignment_snapshot) AS assignment(value);
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_commitment_reserve_people
  AFTER INSERT ON public.school_service_commitments
  FOR EACH ROW EXECUTE FUNCTION public.reserve_school_service_commitment_people();

CREATE FUNCTION public.reserve_school_service_offer_person() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  service public.school_service_commitments%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.status IN ('Declined','Withdrawn') AND OLD.status NOT IN ('Declined','Withdrawn') THEN
      DELETE FROM public.school_service_person_reservations
      WHERE source_kind='Offer' AND offer_id=NEW.offer_id;
    END IF;
    RETURN NEW;
  END IF;
  SELECT commitment.* INTO service
  FROM public.school_service_absences AS absence
  JOIN public.school_service_commitments AS commitment
    ON commitment.commitment_id=absence.commitment_id
  WHERE absence.absence_id=NEW.absence_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Substitute offer requires dated commitment'; END IF;
  IF NEW.status IN ('Offered','Accepted','Acknowledged') THEN
    INSERT INTO public.school_service_person_reservations(
      source_id,source_kind,commitment_id,offer_id,person_id,service_date,start_time,end_time)
    VALUES(NEW.offer_id,'Offer',service.commitment_id,NEW.offer_id,NEW.candidate_person_id,
      service.service_date,service.start_time,service.end_time);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_offer_reserve_person
  AFTER INSERT OR UPDATE ON public.school_service_substitute_offers
  FOR EACH ROW EXECUTE FUNCTION public.reserve_school_service_offer_person();

/* Existing linked rows are derived, never rewritten. Historical unlinked rows stay untouched. */
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
  source_id,source_kind,commitment_id,offer_id,person_id,service_date,start_time,end_time)
SELECT offer.offer_id,'Offer',commitment.commitment_id,offer.offer_id,
  offer.candidate_person_id,commitment.service_date,commitment.start_time,commitment.end_time
FROM public.school_service_substitute_offers AS offer
JOIN public.school_service_absences AS absence USING(absence_id)
JOIN public.school_service_commitments AS commitment ON commitment.commitment_id=absence.commitment_id
WHERE offer.status IN ('Offered','Accepted','Acknowledged')
  AND NOT EXISTS (SELECT 1 FROM public.school_service_decisions AS decision
    WHERE decision.commitment_id=commitment.commitment_id AND decision.outcome='Cancelled');

CREATE FUNCTION public.guard_school_service_person_reservation_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth()<=1 THEN
    RAISE EXCEPTION 'Service person reservation is trigger-maintained';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER school_service_person_reservation_guard
  BEFORE UPDATE OR DELETE ON public.school_service_person_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_service_person_reservation_change();
CREATE FUNCTION public.verify_school_service_decision_occurrence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.occurrence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.school_service_occurrences
    WHERE occurrence_id=NEW.occurrence_id AND commitment_id=NEW.commitment_id
      AND attended_person_ids=NEW.attended_person_ids
  ) THEN
    RAISE EXCEPTION 'Terminal occurrence must match commitment and actual attendance';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER school_service_decision_occurrence_guard
  AFTER INSERT ON public.school_service_decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.verify_school_service_decision_occurrence();

CREATE FUNCTION public.release_cancelled_service_people() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome='Cancelled' THEN
    DELETE FROM public.school_service_person_reservations WHERE commitment_id=NEW.commitment_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER school_service_cancelled_people_release
  AFTER INSERT ON public.school_service_decisions
  FOR EACH ROW EXECUTE FUNCTION public.release_cancelled_service_people();
