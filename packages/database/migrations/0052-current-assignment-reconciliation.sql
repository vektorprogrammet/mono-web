CREATE TABLE public.current_assignment_snapshots (
  snapshot_key text PRIMARY KEY CHECK(snapshot_key ~ '^[a-f0-9]{64}$'),
  source_repository text NOT NULL,
  source_revision text NOT NULL,
  snapshot_id text NOT NULL,
  source_watermark text NOT NULL,
  transformation_revision text NOT NULL,
  snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  occurrence_count integer NOT NULL CHECK(occurrence_count BETWEEN 1 AND 1000),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_repository, snapshot_id)
);

CREATE TABLE public.current_assignment_occurrences (
  snapshot_key text NOT NULL REFERENCES public.current_assignment_snapshots(snapshot_key),
  occurrence_id text NOT NULL,
  disposition text NOT NULL CHECK(disposition IN ('Accepted','Quarantined')),
  reason text NOT NULL CHECK(reason IN (
    'Imported',
    'ExactReplay',
    'InvalidRow',
    'Inactive',
    'DuplicateSource',
    'MappingMissing',
    'MappingAmbiguous',
    'SourceReferenceMismatch',
    'PersonReconciliationMissing',
    'NativeReferenceMissing',
    'SchoolDepartmentMismatch',
    'DuplicateTarget',
    'PlacementOverlap',
    'TargetConflict'
  )),
  PRIMARY KEY(snapshot_key, occurrence_id),
  UNIQUE(snapshot_key, occurrence_id, disposition),
  CHECK((disposition = 'Accepted') = (reason IN ('Imported','ExactReplay')))
);

CREATE TABLE public.current_assignment_imports (
  source_repository text NOT NULL,
  source_assignment_id text NOT NULL,
  source_user_id text NOT NULL,
  source_department_id text NOT NULL,
  source_semester_id text NOT NULL,
  source_school_id text NOT NULL,
  source_row_digest text NOT NULL CHECK(source_row_digest ~ '^[a-f0-9]{64}$'),
  person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  department_id text NOT NULL REFERENCES public.organization_departments(department_id),
  semester_id text NOT NULL REFERENCES public.admission_period_semesters(semester_id),
  school_id bigint NOT NULL REFERENCES public.schools_directory_schools(school_id),
  day text NOT NULL CHECK(day IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
  workdays integer NOT NULL CHECK(workdays BETWEEN 1 AND 8),
  block text NOT NULL CHECK(block IN ('1','2','Both')),
  affiliation_evidence_ref text NOT NULL,
  placement_evidence_ref text NOT NULL,
  placement_id text NOT NULL UNIQUE REFERENCES public.assistant_placements(placement_id),
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  snapshot_key text NOT NULL,
  occurrence_id text NOT NULL,
  occurrence_disposition text NOT NULL DEFAULT 'Accepted' CHECK(occurrence_disposition = 'Accepted'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_repository, source_assignment_id),
  UNIQUE(snapshot_key, occurrence_id),
  FOREIGN KEY(source_repository, source_user_id, person_id)
    REFERENCES public.person_cohort_imports(source_repository, source_user_id, person_id),
  FOREIGN KEY(school_id, department_id)
    REFERENCES public.schools_directory_departments(school_id, department_id),
  FOREIGN KEY(snapshot_key, occurrence_id, occurrence_disposition)
    REFERENCES public.current_assignment_occurrences(snapshot_key, occurrence_id, disposition)
);

CREATE TABLE public.current_assignment_affiliation_imports (
  source_repository text NOT NULL,
  person_id text NOT NULL,
  department_id text NOT NULL,
  source_assignment_id text NOT NULL,
  snapshot_key text NOT NULL,
  occurrence_id text NOT NULL,
  occurrence_disposition text NOT NULL DEFAULT 'Accepted' CHECK(occurrence_disposition = 'Accepted'),
  PRIMARY KEY(source_repository, person_id, department_id),
  FOREIGN KEY(person_id, department_id)
    REFERENCES public.organization_volunteer_affiliations(person_id, department_id),
  FOREIGN KEY(source_repository, source_assignment_id)
    REFERENCES public.current_assignment_imports(source_repository, source_assignment_id),
  FOREIGN KEY(snapshot_key, occurrence_id, occurrence_disposition)
    REFERENCES public.current_assignment_occurrences(snapshot_key, occurrence_id, disposition)
);

CREATE FUNCTION public.prevent_current_assignment_reconciliation_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Current assignment reconciliation evidence is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER current_assignment_snapshots_append_only
  BEFORE UPDATE OR DELETE ON public.current_assignment_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
CREATE TRIGGER current_assignment_occurrences_append_only
  BEFORE UPDATE OR DELETE ON public.current_assignment_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
CREATE TRIGGER current_assignment_imports_append_only
  BEFORE UPDATE OR DELETE ON public.current_assignment_imports
  FOR EACH ROW EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
CREATE TRIGGER current_assignment_affiliation_imports_append_only
  BEFORE UPDATE OR DELETE ON public.current_assignment_affiliation_imports
  FOR EACH ROW EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
CREATE TRIGGER current_assignment_snapshots_truncate_append_only
  BEFORE TRUNCATE ON public.current_assignment_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
CREATE TRIGGER current_assignment_occurrences_truncate_append_only
  BEFORE TRUNCATE ON public.current_assignment_occurrences
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
CREATE TRIGGER current_assignment_imports_truncate_append_only
  BEFORE TRUNCATE ON public.current_assignment_imports
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
CREATE TRIGGER current_assignment_affiliation_imports_truncate_append_only
  BEFORE TRUNCATE ON public.current_assignment_affiliation_imports
  FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_current_assignment_reconciliation_mutation();
