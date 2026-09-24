CREATE TABLE public.organization_cohort_snapshots (
  snapshot_key text PRIMARY KEY CHECK (snapshot_key ~ '^[a-f0-9]{64}$'),
  source_repository text NOT NULL,
  source_revision text NOT NULL,
  snapshot_id text NOT NULL,
  source_watermark text NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  transformation_revision text NOT NULL,
  person_snapshot_key text NOT NULL REFERENCES public.person_cohort_snapshots(snapshot_key),
  reference_digest text NOT NULL,
  review jsonb NOT NULL,
  input_json jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_repository,snapshot_id),
  UNIQUE (snapshot_key,source_repository)
);

CREATE TABLE public.organization_cohort_imports (
  source_repository text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('Team','Board','TeamMembership','BoardMembership')),
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  target_id text NOT NULL,
  snapshot_key text NOT NULL,
  PRIMARY KEY (source_repository,source_kind,source_id),
  UNIQUE (source_kind,target_id),
  FOREIGN KEY (snapshot_key,source_repository) REFERENCES public.organization_cohort_snapshots(snapshot_key,source_repository)
);

CREATE TABLE public.organization_cohort_occurrences (
  snapshot_key text NOT NULL REFERENCES public.organization_cohort_snapshots(snapshot_key),
  occurrence_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('TeamMembership','BoardMembership')),
  source_id text NOT NULL,
  source_row_digest text NOT NULL CHECK (source_row_digest ~ '^[a-f0-9]{64}$'),
  result text NOT NULL CHECK (result IN ('Accepted','Quarantined','Excluded')),
  reason text NOT NULL,
  target_id text,
  PRIMARY KEY (snapshot_key,occurrence_id),
  UNIQUE (snapshot_key,source_kind,source_id),
  CHECK ((result='Accepted') = (target_id IS NOT NULL))
);

CREATE FUNCTION public.freeze_organization_cohort_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Organization cohort evidence is append-only';
END $$;
CREATE TRIGGER organization_cohort_snapshots_append_only BEFORE UPDATE OR DELETE ON public.organization_cohort_snapshots FOR EACH ROW EXECUTE FUNCTION public.freeze_organization_cohort_evidence();
CREATE TRIGGER organization_cohort_snapshots_truncate_append_only BEFORE TRUNCATE ON public.organization_cohort_snapshots FOR EACH STATEMENT EXECUTE FUNCTION public.freeze_organization_cohort_evidence();
CREATE TRIGGER organization_cohort_imports_append_only BEFORE UPDATE OR DELETE ON public.organization_cohort_imports FOR EACH ROW EXECUTE FUNCTION public.freeze_organization_cohort_evidence();
CREATE TRIGGER organization_cohort_imports_truncate_append_only BEFORE TRUNCATE ON public.organization_cohort_imports FOR EACH STATEMENT EXECUTE FUNCTION public.freeze_organization_cohort_evidence();
CREATE TRIGGER organization_cohort_occurrences_append_only BEFORE UPDATE OR DELETE ON public.organization_cohort_occurrences FOR EACH ROW EXECUTE FUNCTION public.freeze_organization_cohort_evidence();
CREATE TRIGGER organization_cohort_occurrences_truncate_append_only BEFORE TRUNCATE ON public.organization_cohort_occurrences FOR EACH STATEMENT EXECUTE FUNCTION public.freeze_organization_cohort_evidence();
