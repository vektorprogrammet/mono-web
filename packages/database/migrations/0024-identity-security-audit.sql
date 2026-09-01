-- Migration 0024: append-only identity security audit (spec 0054.1).
--
-- Identity/session mutations performed by the native AuthLive adapter append
-- their audit transition in the same PostgreSQL transaction. Better Auth
-- sign-in/sign-up operations commit inside Better Auth first; their observed
-- audit event is appended afterward and is deliberately not claimed atomic.

CREATE TABLE IF NOT EXISTS auth.identity_security_audit (
  event_id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_kind text NOT NULL,
  subject_person_id text NULL,
  session_id text NULL,
  actor_principal text NULL,
  request_correlation text NULL,
  source_ip text NULL,
  user_agent text NULL,
  details jsonb NOT NULL,
  CONSTRAINT identity_security_audit_event_id_bounded CHECK (
    event_id = btrim(event_id) AND event_id <> '' AND char_length(event_id) <= 128
  ),
  CONSTRAINT identity_security_audit_kind_closed CHECK (
    event_kind IN (
      'sign-in-success',
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
  ),
  CONSTRAINT identity_security_audit_subject_fk
    FOREIGN KEY (subject_person_id)
    REFERENCES public.person_profiles (person_id)
    ON DELETE RESTRICT,
  CONSTRAINT identity_security_audit_session_bounded CHECK (
    session_id IS NULL OR (
      session_id = btrim(session_id) AND session_id <> '' AND char_length(session_id) <= 128
    )
  ),
  CONSTRAINT identity_security_audit_actor_bounded CHECK (
    actor_principal IS NULL OR (
      actor_principal = btrim(actor_principal)
      AND actor_principal <> ''
      AND char_length(actor_principal) <= 256
      AND actor_principal !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT identity_security_audit_request_context CHECK (
    request_correlation IS NULL OR (
      request_correlation <> ''
      AND char_length(request_correlation) <= 128
      AND request_correlation ~ '^[A-Za-z0-9._:-]+$'
    )
  ),
  CONSTRAINT identity_security_audit_request_bound_correlation CHECK (
    event_kind IN (
      'account-provisioned-administratively',
      'session-provisioned-administratively'
    ) OR request_correlation IS NOT NULL
  ),
  CONSTRAINT identity_security_audit_subject_context CHECK (
    event_kind IN (
      'sign-in-failure',
      'sign-up-rejected',
      'trusted-origin-csrf-rejected'
    ) OR subject_person_id IS NOT NULL
  ),
  CONSTRAINT identity_security_audit_actor_context CHECK (
    event_kind IN (
      'sign-in-failure',
      'sign-up-rejected',
      'trusted-origin-csrf-rejected'
    ) OR actor_principal IS NOT NULL
  ),
  CONSTRAINT identity_security_audit_source_ip_safe CHECK (
    source_ip IS NULL OR (
      source_ip <> ''
      AND char_length(source_ip) <= 64
      AND source_ip ~ '^[A-Fa-f0-9.:]+$'
    )
  ),
  CONSTRAINT identity_security_audit_user_agent_safe CHECK (
    user_agent IS NULL OR (
      user_agent <> ''
      AND char_length(user_agent) <= 256
      AND user_agent !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT identity_security_audit_details_bounded CHECK (
    jsonb_typeof(details) = 'object'
    AND octet_length(details::text) <= 1024
    AND details = jsonb_build_object(
      'outcomeCode', details ->> 'outcomeCode',
      'affectedSessionCount', details -> 'affectedSessionCount'
    )
    AND details ->> 'outcomeCode' IN (
      'credential-accepted',
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
  )
);

CREATE INDEX IF NOT EXISTS identity_security_audit_subject_order
  ON auth.identity_security_audit (subject_person_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS identity_security_audit_session_order
  ON auth.identity_security_audit (session_id, occurred_at, event_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS identity_security_audit_kind_order
  ON auth.identity_security_audit (event_kind, occurred_at, event_id);

CREATE OR REPLACE FUNCTION auth.prevent_identity_security_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Identity security audit rows are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS identity_security_audit_append_only
  ON auth.identity_security_audit;
CREATE TRIGGER identity_security_audit_append_only
  BEFORE UPDATE OR DELETE ON auth.identity_security_audit
  FOR EACH ROW
  EXECUTE FUNCTION auth.prevent_identity_security_audit_mutation();
