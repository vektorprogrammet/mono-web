-- Preserve existing credential provenance while allowing a passwordless identity claim.
ALTER TABLE auth.credential_cohort_imports RENAME TO account_cohort_imports;
ALTER TABLE auth.account_cohort_imports
  RENAME CONSTRAINT credential_cohort_imports_pkey TO account_cohort_imports_pkey;
ALTER TABLE auth.account_cohort_imports
  RENAME CONSTRAINT credential_cohort_imports_person_id_key TO account_cohort_imports_person_id_key;
ALTER TABLE auth.account_cohort_imports
  RENAME CONSTRAINT credential_cohort_imports_account_id_key TO account_cohort_imports_account_id_key;
ALTER TABLE auth.account_cohort_imports
  RENAME CONSTRAINT credential_cohort_imports_person_reconciliation_fk TO account_cohort_imports_person_reconciliation_fk;
ALTER TRIGGER credential_cohort_imports_immutable ON auth.account_cohort_imports
  RENAME TO account_cohort_imports_immutable;

ALTER TABLE auth.account_cohort_imports
  ADD COLUMN import_mode text NOT NULL DEFAULT 'CredentialImported';
ALTER TABLE auth.account_cohort_imports ALTER COLUMN import_mode DROP DEFAULT;
ALTER TABLE auth.account_cohort_imports ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE auth.account_cohort_imports
  ADD CONSTRAINT account_cohort_import_mode_check
  CHECK ((import_mode = 'CredentialImported' AND account_id IS NOT NULL)
      OR (import_mode = 'RecoveryPending' AND account_id IS NULL));

ALTER TABLE auth.credential_cohort_occurrences
  DROP CONSTRAINT credential_cohort_occurrences_reason_check;
ALTER TABLE auth.credential_cohort_occurrences
  ADD CONSTRAINT credential_cohort_occurrences_reason_check
  CHECK (reason IN (
    'Imported', 'RecoveryPending', 'ExactReplay', 'InvalidRow', 'Inactive',
    'MissingPassword', 'UnsupportedHash', 'MappingMissing', 'MappingAmbiguous',
    'EmailUnattested', 'DuplicateSource', 'DuplicateEmail', 'DuplicateTarget',
    'PersonMissing', 'PersonReconciliationMissing', 'TargetConflict', 'EmailConflict'
  ));
ALTER TABLE auth.credential_cohort_occurrences
  DROP CONSTRAINT credential_cohort_occurrences_check;
ALTER TABLE auth.credential_cohort_occurrences
  ADD CONSTRAINT credential_cohort_occurrences_check
  CHECK ((disposition = 'Accepted') = (reason IN ('Imported', 'RecoveryPending', 'ExactReplay')));

ALTER TABLE auth.identity_security_audit DROP CONSTRAINT identity_security_audit_kind_closed;
ALTER TABLE auth.identity_security_audit ADD CONSTRAINT identity_security_audit_kind_closed CHECK (
  event_kind IN (
    'sign-in-success', 'sign-in-failure', 'sign-out', 'session-revoked-one',
    'session-revoked-others', 'session-revoked-all', 'sign-up-rejected',
    'trusted-origin-csrf-rejected', 'account-provisioned-administratively',
    'recovery-identity-provisioned-administratively', 'session-provisioned-administratively',
    'password-reset-request-accepted', 'password-reset-request-rejected',
    'password-reset-mail-enqueue-failed', 'password-reset-mail-delivered',
    'password-reset-mail-failed', 'password-reset-success', 'password-reset-failure'
  )
);
ALTER TABLE auth.identity_security_audit DROP CONSTRAINT identity_security_audit_request_bound_correlation;
ALTER TABLE auth.identity_security_audit ADD CONSTRAINT identity_security_audit_request_bound_correlation CHECK (
  event_kind IN (
    'password-reset-mail-delivered', 'password-reset-mail-failed',
    'account-provisioned-administratively', 'recovery-identity-provisioned-administratively',
    'session-provisioned-administratively'
  ) OR request_correlation IS NOT NULL
);

ALTER TABLE auth.identity_security_audit DROP CONSTRAINT identity_security_audit_details_bounded;
ALTER TABLE auth.identity_security_audit ADD CONSTRAINT identity_security_audit_details_bounded CHECK (
  jsonb_typeof(details) = 'object'
  AND octet_length(details::text) <= 1024
  AND details = jsonb_build_object(
    'outcomeCode', details ->> 'outcomeCode',
    'affectedSessionCount', details -> 'affectedSessionCount'
  )
  AND details ->> 'outcomeCode' IN (
    'credential-accepted', 'mail-enqueued', 'identity-undisclosed', 'input-invalid',
    'redirect-not-allowed', 'rate-limited', 'outbox-unavailable', 'provider-acknowledged',
    'provider-rejected', 'provider-unavailable', 'delivery-timeout', 'verification-invalid',
    'verification-expired', 'authority-mismatch', 'password-updated-sessions-revoked',
    'invalid-token', 'password-policy-rejected', 'engine-failure', 'credential-rejected',
    'current-session-ended', 'owned-session-revoked', 'other-sessions-revoked',
    'all-sessions-revoked', 'public-sign-up-disabled', 'origin-not-trusted',
    'account-provisioned', 'session-provisioned', 'recovery-pending'
  )
  AND (
    jsonb_typeof(details -> 'affectedSessionCount') = 'null'
    OR (
      jsonb_typeof(details -> 'affectedSessionCount') = 'number'
      AND mod((details ->> 'affectedSessionCount')::numeric, 1) = 0
      AND (details ->> 'affectedSessionCount')::numeric BETWEEN 0 AND 10000
    )
  )
);
