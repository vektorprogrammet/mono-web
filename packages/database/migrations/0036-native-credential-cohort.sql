CREATE TABLE auth.credential_cohort_snapshots (
  snapshot_key text PRIMARY KEY CHECK(snapshot_key ~ '^[a-f0-9]{64}$'),
  source_repository text NOT NULL,
  snapshot_id text NOT NULL,
  source_revision text NOT NULL,
  transformation_revision text NOT NULL,
  snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  occurrence_count integer NOT NULL CHECK(occurrence_count BETWEEN 1 AND 1000),
  UNIQUE(source_repository,snapshot_id)
);
CREATE TABLE auth.credential_cohort_occurrences (
  snapshot_key text NOT NULL REFERENCES auth.credential_cohort_snapshots(snapshot_key),
  occurrence_id text NOT NULL,
  disposition text NOT NULL CHECK(disposition IN ('Accepted','Quarantined')),
  reason text NOT NULL CHECK(reason IN ('Imported','ExactReplay','InvalidRow','Inactive','MissingPassword','UnsupportedHash','MappingMissing','MappingAmbiguous','EmailUnattested','DuplicateSource','DuplicateEmail','DuplicateTarget','PersonMissing','TargetConflict','EmailConflict')),
  PRIMARY KEY(snapshot_key,occurrence_id),
  CHECK((disposition='Accepted')=(reason IN ('Imported','ExactReplay')))
);
CREATE UNIQUE INDEX credential_account_principal_identity ON auth."account"("id","userId");
CREATE TABLE auth.credential_cohort_imports (
  source_repository text NOT NULL,
  source_user_id text NOT NULL,
  person_id text NOT NULL UNIQUE REFERENCES auth."user"("id"),
  account_id text NOT NULL UNIQUE,
  source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  snapshot_key text NOT NULL,
  occurrence_id text NOT NULL,
  PRIMARY KEY(source_repository,source_user_id),
  FOREIGN KEY(account_id,person_id) REFERENCES auth."account"("id","userId"),
  FOREIGN KEY(snapshot_key,occurrence_id) REFERENCES auth.credential_cohort_occurrences(snapshot_key,occurrence_id)
);
CREATE FUNCTION auth.freeze_credential_cohort_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Credential cohort evidence is immutable'; END;
$$;
CREATE TRIGGER credential_cohort_snapshots_immutable BEFORE UPDATE OR DELETE ON auth.credential_cohort_snapshots FOR EACH ROW EXECUTE FUNCTION auth.freeze_credential_cohort_evidence();
CREATE TRIGGER credential_cohort_occurrences_immutable BEFORE UPDATE OR DELETE ON auth.credential_cohort_occurrences FOR EACH ROW EXECUTE FUNCTION auth.freeze_credential_cohort_evidence();
CREATE TRIGGER credential_cohort_imports_immutable BEFORE UPDATE OR DELETE ON auth.credential_cohort_imports FOR EACH ROW EXECUTE FUNCTION auth.freeze_credential_cohort_evidence();
