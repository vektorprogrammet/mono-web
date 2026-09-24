CREATE TABLE public.receipt_cohort_snapshots (
  snapshot_key text PRIMARY KEY CHECK (snapshot_key ~ '^[a-f0-9]{64}$'),
  source_repository text NOT NULL,
  snapshot_id text NOT NULL,
  source_revision text NOT NULL,
  receipt_source_revision text NOT NULL CHECK (receipt_source_revision ~ '^[a-f0-9]{64}$'),
  source_watermark text NOT NULL,
  transformation_revision text NOT NULL,
  person_snapshot_key text NOT NULL REFERENCES public.person_cohort_snapshots(snapshot_key),
  reference_snapshot_id text NOT NULL,
  reference_digest text NOT NULL CHECK (reference_digest ~ '^[a-f0-9]{64}$'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  review_json jsonb NOT NULL CHECK (jsonb_typeof(review_json) = 'object'),
  occurrence_count integer NOT NULL CHECK (occurrence_count >= 0),
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_repository, snapshot_id),
  UNIQUE (snapshot_key, source_repository),
  FOREIGN KEY (source_repository, reference_snapshot_id)
    REFERENCES public.historical_service_reference_provenance(source_repository, snapshot_id)
);

CREATE TABLE public.receipt_cohort_occurrences (
  snapshot_key text NOT NULL REFERENCES public.receipt_cohort_snapshots(snapshot_key),
  source_primary_key text NOT NULL,
  source_row_digest text NOT NULL CHECK (source_row_digest ~ '^[a-f0-9]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('Accepted', 'Quarantined', 'Excluded')),
  reasons_json jsonb NOT NULL CHECK (jsonb_typeof(reasons_json) = 'array'),
  accepted_result_json jsonb,
  PRIMARY KEY (snapshot_key, source_primary_key),
  CHECK ((disposition = 'Accepted') = (accepted_result_json IS NOT NULL)),
  CHECK (accepted_result_json IS NULL OR jsonb_typeof(accepted_result_json) = 'object')
);

-- Only persisted acceptance owns a source across snapshots. Quarantines remain
-- immutable within their cohort but can be reviewed again in a new snapshot.
CREATE TABLE public.receipt_cohort_source_bindings (
  source_repository text NOT NULL,
  source_primary_key text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  review_digest text NOT NULL CHECK (review_digest ~ '^[a-f0-9]{64}$'),
  transformation_revision text NOT NULL,
  destination_identity text NOT NULL UNIQUE REFERENCES public.economy_receipts(receipt_id),
  snapshot_key text NOT NULL,
  PRIMARY KEY (source_repository, source_primary_key),
  FOREIGN KEY (snapshot_key, source_repository)
    REFERENCES public.receipt_cohort_snapshots(snapshot_key, source_repository),
  FOREIGN KEY (snapshot_key, source_primary_key)
    REFERENCES public.receipt_cohort_occurrences(snapshot_key, source_primary_key)
);

CREATE FUNCTION public.freeze_receipt_cohort_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Receipt cohort evidence is append-only';
END $$;
CREATE TRIGGER receipt_cohort_snapshots_append_only BEFORE UPDATE OR DELETE ON public.receipt_cohort_snapshots FOR EACH ROW EXECUTE FUNCTION public.freeze_receipt_cohort_evidence();
CREATE TRIGGER receipt_cohort_snapshots_truncate_append_only BEFORE TRUNCATE ON public.receipt_cohort_snapshots FOR EACH STATEMENT EXECUTE FUNCTION public.freeze_receipt_cohort_evidence();
CREATE TRIGGER receipt_cohort_occurrences_append_only BEFORE UPDATE OR DELETE ON public.receipt_cohort_occurrences FOR EACH ROW EXECUTE FUNCTION public.freeze_receipt_cohort_evidence();
CREATE TRIGGER receipt_cohort_occurrences_truncate_append_only BEFORE TRUNCATE ON public.receipt_cohort_occurrences FOR EACH STATEMENT EXECUTE FUNCTION public.freeze_receipt_cohort_evidence();
CREATE TRIGGER receipt_cohort_source_bindings_append_only BEFORE UPDATE OR DELETE ON public.receipt_cohort_source_bindings FOR EACH ROW EXECUTE FUNCTION public.freeze_receipt_cohort_evidence();
CREATE TRIGGER receipt_cohort_source_bindings_truncate_append_only BEFORE TRUNCATE ON public.receipt_cohort_source_bindings FOR EACH STATEMENT EXECUTE FUNCTION public.freeze_receipt_cohort_evidence();
