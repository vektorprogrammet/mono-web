-- Spec0054.2: credential-free reset delivery state and append-only audit extension.
ALTER TABLE auth.identity_security_audit DROP CONSTRAINT identity_security_audit_kind_closed;
ALTER TABLE auth.identity_security_audit ADD CONSTRAINT identity_security_audit_kind_closed CHECK (
    event_kind IN (
      'sign-in-success',
'password-reset-request-accepted','password-reset-request-rejected','password-reset-mail-enqueue-failed','password-reset-mail-delivered','password-reset-mail-failed','password-reset-success','password-reset-failure',
      'sign-in-failure',
      'sign-out',
      'session-revoked-one',
      'session-revoked-others',
      'session-revoked-all',
      'sign-up-rejected',
      'trusted-origin-csrf-rejected',
      'account-provisioned-administratively',
      'session-provisioned-administratively'
    )
  );
ALTER TABLE auth.identity_security_audit DROP CONSTRAINT identity_security_audit_request_bound_correlation;
ALTER TABLE auth.identity_security_audit ADD CONSTRAINT identity_security_audit_request_bound_correlation CHECK (
    event_kind IN ('password-reset-mail-delivered','password-reset-mail-failed',
      'account-provisioned-administratively',
      'session-provisioned-administratively'
    ) OR request_correlation IS NOT NULL
  );
ALTER TABLE auth.identity_security_audit DROP CONSTRAINT identity_security_audit_subject_context;
ALTER TABLE auth.identity_security_audit ADD CONSTRAINT identity_security_audit_subject_context CHECK (
    event_kind IN ('password-reset-request-accepted','password-reset-request-rejected','password-reset-mail-enqueue-failed','password-reset-failure',
      'sign-in-failure',
      'sign-up-rejected',
      'trusted-origin-csrf-rejected'
    ) OR subject_person_id IS NOT NULL
  );
ALTER TABLE auth.identity_security_audit DROP CONSTRAINT identity_security_audit_actor_context;
ALTER TABLE auth.identity_security_audit ADD CONSTRAINT identity_security_audit_actor_context CHECK (
    event_kind IN ('password-reset-request-accepted','password-reset-request-rejected','password-reset-mail-enqueue-failed','password-reset-mail-delivered','password-reset-mail-failed','password-reset-success','password-reset-failure',
      'sign-in-failure',
      'sign-up-rejected',
      'trusted-origin-csrf-rejected'
    ) OR actor_principal IS NOT NULL
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
      'credential-accepted','mail-enqueued','identity-undisclosed','input-invalid','redirect-not-allowed','rate-limited','outbox-unavailable','provider-acknowledged','provider-rejected','provider-unavailable','delivery-timeout','verification-invalid','verification-expired','authority-mismatch','password-updated-sessions-revoked','invalid-token','password-policy-rejected','engine-failure',
      'credential-rejected',
      'current-session-ended',
      'owned-session-revoked',
      'other-sessions-revoked',
      'all-sessions-revoked',
      'public-sign-up-disabled',
      'origin-not-trusted',
      'account-provisioned',
      'session-provisioned'
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

CREATE TABLE auth.password_reset_email_outbox (
 effect_id text PRIMARY KEY,
 verification_id text NOT NULL UNIQUE CHECK (verification_id <> '' AND char_length(verification_id) <= 128),
 CHECK (effect_id = 'password-reset:' || verification_id),
 subject_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
 status text NOT NULL CHECK(status IN ('Pending','Processing','Delivered','Failed','Quarantined')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 claim_id uuid,
 claimed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 delivered_at timestamptz,
 last_failure_code text CHECK(last_failure_code IN ('stale-claim','provider-rejected','provider-unavailable','delivery-timeout','verification-invalid','verification-expired','authority-mismatch')),
 CHECK ((status = 'Processing') = (claim_id IS NOT NULL AND claimed_at IS NOT NULL)),
 CHECK (status = 'Processing' OR (claim_id IS NULL AND claimed_at IS NULL)),
 CHECK ((status = 'Delivered') = (delivered_at IS NOT NULL))
);
CREATE INDEX password_reset_email_outbox_pending ON auth.password_reset_email_outbox(created_at,effect_id) WHERE status IN ('Pending','Failed','Processing');
