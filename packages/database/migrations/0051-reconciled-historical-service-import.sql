ALTER TABLE public.person_cohort_imports
  ADD CONSTRAINT person_cohort_imports_source_person_unique
  UNIQUE(source_repository, source_user_id, person_id);

CREATE TABLE public.historical_service_snapshots (
  snapshot_key text PRIMARY KEY CHECK(snapshot_key ~ '^[a-f0-9]{64}$'),
  source_repository text NOT NULL,
  snapshot_id text NOT NULL,
  source_revision text NOT NULL,
  transformation_revision text NOT NULL,
  snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  occurrence_count integer NOT NULL CHECK(occurrence_count BETWEEN 1 AND 1000),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_repository, snapshot_id)
);

CREATE TABLE public.historical_service_occurrences (
  snapshot_key text NOT NULL REFERENCES public.historical_service_snapshots(snapshot_key),
  occurrence_id text NOT NULL,
  disposition text NOT NULL CHECK(disposition IN ('Accepted','Quarantined')),
  reason text NOT NULL CHECK(reason IN (
    'Imported',
    'ExactReplay',
    'InvalidRow',
    'DuplicateSource',
    'MappingMissing',
    'MappingAmbiguous',
    'SourceReferenceMismatch',
    'PersonReconciliationMissing',
    'NativeReferenceMissing',
    'SchoolDepartmentMismatch',
    'DuplicateTarget',
    'TargetConflict'
  )),
  PRIMARY KEY(snapshot_key, occurrence_id),
  UNIQUE(snapshot_key, occurrence_id, disposition),
  CHECK((disposition = 'Accepted') = (reason IN ('Imported','ExactReplay')))
);

CREATE TABLE public.assistant_service_history (
  source_repository text NOT NULL,
  source_history_id text NOT NULL,
  source_user_id text NOT NULL,
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  school_id bigint NOT NULL REFERENCES public.schools_directory_schools(school_id),
  day text NOT NULL CHECK(day IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
  workdays integer NOT NULL CHECK(workdays BETWEEN 1 AND 8),
  block text NOT NULL CHECK(block IN ('1','2','Both')),
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  evidence_ref text NOT NULL,
  snapshot_key text NOT NULL,
  occurrence_id text NOT NULL,
  occurrence_disposition text NOT NULL DEFAULT 'Accepted' CHECK(occurrence_disposition = 'Accepted'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_repository, source_history_id),
  UNIQUE(snapshot_key, occurrence_id),
  FOREIGN KEY(source_repository, source_user_id, person_id)
    REFERENCES public.person_cohort_imports(source_repository, source_user_id, person_id),
  FOREIGN KEY(school_id, department_id)
    REFERENCES public.schools_directory_departments(school_id, department_id),
  FOREIGN KEY(snapshot_key, occurrence_id, occurrence_disposition)
    REFERENCES public.historical_service_occurrences(snapshot_key, occurrence_id, disposition)
);

CREATE VIEW public.assistant_affiliation_history AS
SELECT DISTINCT person_id, department_id, semester_id
  FROM public.assistant_service_history;

CREATE FUNCTION public.prevent_historical_service_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Historical service reconciliation rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER historical_service_snapshots_append_only
  BEFORE UPDATE OR DELETE ON public.historical_service_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.prevent_historical_service_mutation();
CREATE TRIGGER historical_service_occurrences_append_only
  BEFORE UPDATE OR DELETE ON public.historical_service_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.prevent_historical_service_mutation();
CREATE TRIGGER assistant_service_history_append_only
  BEFORE UPDATE OR DELETE ON public.assistant_service_history
  FOR EACH ROW EXECUTE FUNCTION public.prevent_historical_service_mutation();
