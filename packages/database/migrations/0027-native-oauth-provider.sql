-- Migration 0027: native OAuth provider (spec 0082).
-- Provider relations were generated from better-auth and
-- @better-auth/oauth-provider 1.7.1 with:
--   bunx --bun auth@1.7.1 generate \
--     --config packages/database/src/auth-schema-generator.config.ts \
--     --output /tmp/auth-schema-0027.sql --yes
-- Runtime migration is disabled; this checked-in migration is the schema authority.

CREATE TABLE auth.jwks (
  "id" text PRIMARY KEY,
  "publicKey" text NOT NULL,
  "privateKey" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "expiresAt" timestamptz,
  "alg" text,
  "crv" text
);

CREATE TABLE auth."oauthClient" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" boolean,
  "skipConsent" boolean,
  "enableEndSession" boolean,
  "subjectType" text,
  "scopes" jsonb,
  "clientCredentialsScopes" jsonb,
  "userId" text REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" jsonb,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" jsonb NOT NULL,
  "postLogoutRedirectUris" jsonb,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" boolean,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" jsonb,
  "responseTypes" jsonb,
  "requirePKCE" boolean,
  "dpopBoundAccessTokens" boolean,
  "referenceId" text,
  "metadata" jsonb
);

CREATE TABLE auth."oauthResource" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" jsonb,
  "customClaims" jsonb,
  "dpopBoundAccessTokensRequired" boolean,
  "disabled" boolean,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "policyVersion" integer,
  "metadata" jsonb
);

CREATE TABLE auth."oauthClientResource" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES auth."oauthClient" ("clientId") ON DELETE CASCADE,
  "resourceId" text NOT NULL REFERENCES auth."oauthResource" ("identifier") ON DELETE CASCADE,
  "metadata" jsonb,
  "createdAt" timestamptz
);

CREATE TABLE auth."oauthRefreshToken" (
  "id" text PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES auth."oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES auth."session" ("id") ON DELETE SET NULL,
  "userId" text NOT NULL REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "revoked" timestamptz,
  "rotatedAt" timestamptz,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" timestamptz,
  "authTime" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb NOT NULL
);

CREATE TABLE auth."oauthAccessToken" (
  "id" text PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES auth."oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES auth."session" ("id") ON DELETE SET NULL,
  "userId" text REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "refreshId" text REFERENCES auth."oauthRefreshToken" ("id") ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "revoked" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb NOT NULL
);

CREATE TABLE auth."oauthConsent" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES auth."oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES auth."user" ("id") ON DELETE CASCADE,
  "referenceId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "scopes" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE auth."oauthClientAssertion" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL
);

CREATE INDEX "oauthClient_userId_idx" ON auth."oauthClient" ("userId");
CREATE INDEX "oauthClientResource_clientId_idx" ON auth."oauthClientResource" ("clientId");
CREATE INDEX "oauthClientResource_resourceId_idx" ON auth."oauthClientResource" ("resourceId");
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON auth."oauthClientResource" ("clientId", "resourceId");
CREATE INDEX "oauthRefreshToken_clientId_idx" ON auth."oauthRefreshToken" ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON auth."oauthRefreshToken" ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON auth."oauthRefreshToken" ("userId");
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON auth."oauthRefreshToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_clientId_idx" ON auth."oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON auth."oauthAccessToken" ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON auth."oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON auth."oauthAccessToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON auth."oauthAccessToken" ("refreshId");
CREATE INDEX "oauthConsent_clientId_idx" ON auth."oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON auth."oauthConsent" ("userId");

CREATE TABLE public.service_principals (
  service_principal_id text PRIMARY KEY,
  name text NOT NULL CHECK (name = btrim(name) AND name <> ''),
  state text NOT NULL CHECK (state IN ('Active', 'Disabled')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (updated_at >= created_at)
);

CREATE TABLE auth.oauth_client_bindings (
  client_id text PRIMARY KEY REFERENCES auth."oauthClient" ("clientId") ON DELETE RESTRICT,
  client_kind text NOT NULL CHECK (client_kind IN ('DelegatedPublic', 'DelegatedConfidential', 'Service', 'ResourceServer')),
  service_principal_id text UNIQUE REFERENCES public.service_principals (service_principal_id) ON DELETE RESTRICT,
  secret_expires_at timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (updated_at >= created_at),
  CHECK ((client_kind = 'Service') = (service_principal_id IS NOT NULL)),
  CHECK ((client_kind = 'DelegatedPublic') = (secret_expires_at IS NULL))
);

CREATE TABLE auth.oauth_refresh_families (
  family_id text PRIMARY KEY,
  authorization_code_id text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES auth.oauth_client_bindings (client_id) ON DELETE RESTRICT,
  person_id text NOT NULL REFERENCES auth."user" ("id") ON DELETE RESTRICT,
  session_id text NOT NULL REFERENCES auth."session" ("id") ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  inactivity_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  CHECK (last_used_at >= created_at),
  CHECK (absolute_expires_at = created_at + interval '30 days'),
  CHECK (inactivity_expires_at <= last_used_at + interval '7 days'),
  CHECK (inactivity_expires_at <= absolute_expires_at),
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (revocation_reason IS NULL OR revocation_reason IN (
    'explicit-refresh-token', 'consent-withdrawn', 'refresh-replay', 'code-replay',
    'session-inactive', 'client-disabled', 'service-principal-disabled', 'operator-repair'
  ))
);
CREATE INDEX oauth_refresh_families_client_person_idx ON auth.oauth_refresh_families (client_id, person_id);
CREATE INDEX oauth_refresh_families_session_idx ON auth.oauth_refresh_families (session_id);

CREATE TABLE auth.oauth_access_token_state (
  jti text PRIMARY KEY,
  family_id text REFERENCES auth.oauth_refresh_families (family_id) ON DELETE RESTRICT,
  client_id text NOT NULL REFERENCES auth.oauth_client_bindings (client_id) ON DELETE RESTRICT,
  principal_kind text NOT NULL CHECK (principal_kind IN ('Person', 'ServicePrincipal')),
  person_id text REFERENCES auth."user" ("id") ON DELETE RESTRICT,
  service_principal_id text REFERENCES public.service_principals (service_principal_id) ON DELETE RESTRICT,
  session_id text REFERENCES auth."session" ("id") ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  CHECK (expires_at > issued_at),
  CHECK ((principal_kind = 'Person') = (person_id IS NOT NULL)),
  CHECK ((principal_kind = 'ServicePrincipal') = (service_principal_id IS NOT NULL)),
  CHECK ((principal_kind = 'Person') = (session_id IS NOT NULL)),
  CHECK (NOT (person_id IS NOT NULL AND service_principal_id IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (revocation_reason IS NULL OR revocation_reason IN (
    'explicit-access-token', 'explicit-refresh-token', 'consent-withdrawn',
    'refresh-replay', 'code-replay', 'session-inactive', 'client-disabled',
    'service-principal-disabled', 'operator-repair'
  ))
);
CREATE INDEX oauth_access_token_state_family_idx ON auth.oauth_access_token_state (family_id);
CREATE INDEX oauth_access_token_state_client_idx ON auth.oauth_access_token_state (client_id);
CREATE INDEX oauth_access_token_state_person_idx ON auth.oauth_access_token_state (person_id);
CREATE INDEX oauth_access_token_state_service_idx ON auth.oauth_access_token_state (service_principal_id);
CREATE INDEX oauth_access_token_state_session_idx ON auth.oauth_access_token_state (session_id);

CREATE TABLE auth.oauth_security_audit (
  event_id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN (
    'oauth-client-provisioned', 'oauth-client-secret-rotated', 'oauth-client-disabled',
    'oauth-service-principal-disabled', 'oauth-consent-accepted', 'oauth-consent-denied',
    'oauth-consent-withdrawn', 'oauth-authorization-code-issued',
    'oauth-authorization-code-rejected', 'oauth-authorization-code-replay',
    'oauth-token-issued', 'oauth-refresh-rotated', 'oauth-refresh-replay',
    'oauth-access-token-revoked', 'oauth-refresh-family-revoked',
    'oauth-client-authentication-rejected', 'oauth-bearer-rejected',
    'oauth-introspection-rejected', 'oauth-signing-key-rotated'
  )),
  client_id text REFERENCES auth.oauth_client_bindings (client_id) ON DELETE RESTRICT,
  family_id text REFERENCES auth.oauth_refresh_families (family_id) ON DELETE RESTRICT,
  jti text REFERENCES auth.oauth_access_token_state (jti) ON DELETE RESTRICT,
  subject_person_id text REFERENCES auth."user" ("id") ON DELETE RESTRICT,
  subject_service_principal_id text REFERENCES public.service_principals (service_principal_id) ON DELETE RESTRICT,
  actor_principal text NOT NULL CHECK (char_length(actor_principal) BETWEEN 1 AND 160),
  request_correlation text NOT NULL CHECK (char_length(request_correlation) BETWEEN 1 AND 160),
  source_ip text CHECK (source_ip IS NULL OR char_length(source_ip) <= 64),
  user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX oauth_security_audit_occurred_idx ON auth.oauth_security_audit (occurred_at);
CREATE INDEX oauth_security_audit_client_idx ON auth.oauth_security_audit (client_id);

CREATE FUNCTION auth.oauth_security_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'oauth security audit is append-only';
END;
$$;
CREATE TRIGGER oauth_security_audit_no_update
  BEFORE UPDATE OR DELETE ON auth.oauth_security_audit
  FOR EACH ROW EXECUTE FUNCTION auth.oauth_security_audit_append_only();

CREATE FUNCTION auth.oauth_security_audit_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed_keys constant text[] := ARRAY[
    'client_kind', 'denial_category', 'resource', 'scopes', 'affected_count',
    'revocation_reason', 'key_id', 'credential_kind'
  ];
  detail_key text;
BEGIN
  FOR detail_key IN SELECT jsonb_object_keys(NEW.details)
  LOOP
    IF NOT (detail_key = ANY (allowed_keys)) THEN
      RAISE EXCEPTION 'forbidden oauth audit detail key';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER oauth_security_audit_validate_insert
  BEFORE INSERT ON auth.oauth_security_audit
  FOR EACH ROW EXECUTE FUNCTION auth.oauth_security_audit_validate();
