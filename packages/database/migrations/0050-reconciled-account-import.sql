ALTER TABLE public.person_cohort_imports
  ADD CONSTRAINT person_cohort_imports_source_identity_unique
  UNIQUE (source_repository, source_user_id, person_id);

ALTER TABLE auth.credential_cohort_occurrences
  DROP CONSTRAINT credential_cohort_occurrences_reason_check;

ALTER TABLE auth.credential_cohort_occurrences
  ADD CONSTRAINT credential_cohort_occurrences_reason_check
  CHECK (reason IN (
    'Imported',
    'ExactReplay',
    'InvalidRow',
    'Inactive',
    'MissingPassword',
    'UnsupportedHash',
    'MappingMissing',
    'MappingAmbiguous',
    'EmailUnattested',
    'DuplicateSource',
    'DuplicateEmail',
    'DuplicateTarget',
    'PersonMissing',
    'PersonReconciliationMissing',
    'TargetConflict',
    'EmailConflict'
  ));

ALTER TABLE auth.credential_cohort_imports
  ADD CONSTRAINT credential_cohort_imports_person_reconciliation_fk
  FOREIGN KEY (source_repository, source_user_id, person_id)
  REFERENCES public.person_cohort_imports(source_repository, source_user_id, person_id);
