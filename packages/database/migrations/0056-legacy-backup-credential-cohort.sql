ALTER TABLE auth.credential_cohort_snapshots
  ADD COLUMN source_kind text NOT NULL DEFAULT 'Synthetic'
  CONSTRAINT credential_cohort_snapshots_source_kind_check
  CHECK (source_kind IN ('Synthetic', 'LegacyBackup'));

ALTER TABLE auth.credential_cohort_snapshots
  DROP CONSTRAINT credential_cohort_snapshots_occurrence_count_check;

ALTER TABLE auth.credential_cohort_snapshots
  ADD CONSTRAINT credential_cohort_snapshots_occurrence_count_check
  CHECK (occurrence_count BETWEEN 1 AND 10000);

ALTER TABLE auth.credential_cohort_snapshots ALTER COLUMN source_kind DROP DEFAULT;
