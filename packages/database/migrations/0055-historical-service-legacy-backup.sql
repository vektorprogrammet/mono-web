ALTER TABLE public.historical_service_snapshots
  ADD COLUMN source_kind text NOT NULL DEFAULT 'Synthetic'
    CHECK (source_kind IN ('Synthetic', 'LegacyBackup'));

ALTER TABLE public.historical_service_snapshots
  DROP CONSTRAINT historical_service_snapshots_occurrence_count_check;

ALTER TABLE public.historical_service_snapshots
  ADD CONSTRAINT historical_service_snapshots_occurrence_count_check
    CHECK (occurrence_count BETWEEN 1 AND 10000);

-- Existing synthetic provenance predates raw-row attestations; retain it unchanged.
ALTER TABLE public.historical_service_occurrences
  ADD COLUMN raw_row_digest text CHECK (raw_row_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN source_row_digest text CHECK (source_row_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT historical_service_occurrences_attested_digest_check
    CHECK (disposition <> 'Accepted' OR source_row_digest IS NULL OR source_row_digest = raw_row_digest);

CREATE FUNCTION public.require_historical_service_backup_digest()
RETURNS trigger AS $$
BEGIN
  IF NEW.disposition = 'Accepted'
     AND (SELECT source_kind FROM public.historical_service_snapshots
           WHERE snapshot_key = NEW.snapshot_key) = 'LegacyBackup'
     AND (NEW.source_row_digest IS NULL OR NEW.raw_row_digest IS NULL
          OR NEW.source_row_digest <> NEW.raw_row_digest) THEN
    RAISE EXCEPTION 'Accepted legacy history requires its raw-row digest';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER historical_service_backup_digest_required
  BEFORE INSERT ON public.historical_service_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.require_historical_service_backup_digest();

-- The cutover driver records reference seeding before it imports the service snapshot.
-- This evidence has the same immutable source identity but no premature snapshot FK.
CREATE TABLE public.historical_service_reference_provenance (
  source_repository text NOT NULL,
  snapshot_id text NOT NULL,
  source_revision text NOT NULL,
  reference_digest text NOT NULL CHECK (reference_digest ~ '^[a-f0-9]{64}$'),
  source_id_mappings jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_repository, snapshot_id)
);

CREATE TRIGGER historical_service_reference_provenance_append_only
  BEFORE UPDATE OR DELETE ON public.historical_service_reference_provenance
  FOR EACH ROW EXECUTE FUNCTION public.prevent_historical_service_mutation();
