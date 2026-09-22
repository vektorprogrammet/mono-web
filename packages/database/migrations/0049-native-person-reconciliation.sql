CREATE TABLE public.person_cohort_snapshots (
  snapshot_key text PRIMARY KEY CHECK (snapshot_key ~ '^[a-f0-9]{64}$'),
  source_repository text NOT NULL,
  snapshot_id text NOT NULL,
  source_revision text NOT NULL,
  transformation_revision text NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  occurrence_count integer NOT NULL CHECK (occurrence_count BETWEEN 1 AND 1000),
  UNIQUE (source_repository, snapshot_id)
);

CREATE TABLE public.person_cohort_occurrences (
  snapshot_key text NOT NULL REFERENCES public.person_cohort_snapshots(snapshot_key),
  occurrence_id text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('Accepted', 'Quarantined')),
  reason text NOT NULL CHECK (reason IN (
    'CreatedPerson',
    'LinkedExistingPerson',
    'ExactReplay',
    'InvalidRow',
    'Inactive',
    'MappingMissing',
    'MappingAmbiguous',
    'EmailUnattested',
    'DuplicateSource',
    'DuplicateEmail',
    'DuplicateTarget',
    'TargetConflict',
    'EmailConflict',
    'PersonMissing',
    'ExistingPersonStale',
    'ExistingEmailConflict'
  )),
  PRIMARY KEY (snapshot_key, occurrence_id),
  CHECK (
    (disposition = 'Accepted') =
    (reason IN ('CreatedPerson', 'LinkedExistingPerson', 'ExactReplay'))
  )
);

CREATE TABLE public.person_cohort_imports (
  source_repository text NOT NULL,
  source_user_id text NOT NULL,
  person_id text NOT NULL UNIQUE REFERENCES public.person_profiles(person_id),
  mapping_action text NOT NULL CHECK (mapping_action IN ('CreatePerson', 'LinkExistingPerson')),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  evidence_ref text NOT NULL,
  snapshot_key text NOT NULL,
  occurrence_id text NOT NULL,
  PRIMARY KEY (source_repository, source_user_id),
  FOREIGN KEY (snapshot_key, occurrence_id)
    REFERENCES public.person_cohort_occurrences(snapshot_key, occurrence_id)
);

CREATE FUNCTION public.freeze_person_cohort_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Person cohort evidence is immutable';
END;
$$;

CREATE TRIGGER person_cohort_snapshots_immutable
BEFORE UPDATE OR DELETE ON public.person_cohort_snapshots
FOR EACH ROW EXECUTE FUNCTION public.freeze_person_cohort_evidence();

CREATE TRIGGER person_cohort_occurrences_immutable
BEFORE UPDATE OR DELETE ON public.person_cohort_occurrences
FOR EACH ROW EXECUTE FUNCTION public.freeze_person_cohort_evidence();

CREATE TRIGGER person_cohort_imports_immutable
BEFORE UPDATE OR DELETE ON public.person_cohort_imports
FOR EACH ROW EXECUTE FUNCTION public.freeze_person_cohort_evidence();
