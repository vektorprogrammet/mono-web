-- The OAuth refresh windows are elapsed time: a family lives 720 hours (30 days of 24 hours)
-- from its first token, and 168 hours (7 days of 24 hours) without a refresh. Migration 0027
-- checked them as `+ interval '30 days'` and `+ interval '7 days'`. PostgreSQL adds days in the
-- session TimeZone, so in a zone with daylight saving time a window across a clock change was one
-- hour shorter or longer, and the check rejected the code exchange of the application.
--
-- These functions are the one definition of both windows. The checks below and the
-- statements of the application (packages/database/src/oauth-live.ts) call them. Hour
-- intervals do not depend on the session TimeZone, so the functions are immutable.

CREATE FUNCTION auth.oauth_refresh_absolute_expires_at(created_at timestamptz)
  RETURNS timestamptz
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN created_at + interval '720 hours';

CREATE FUNCTION auth.oauth_refresh_inactivity_expires_at(
  last_used_at timestamptz,
  absolute_expires_at timestamptz
)
  RETURNS timestamptz
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN LEAST(last_used_at + interval '168 hours', absolute_expires_at);

-- Existing rows satisfy the new checks, so this migration rewrites none. The application wrote
-- an absolute window of 720 hours, which the old check admitted only where 30 days were 720
-- hours. A refresh rechecked that in its own session, so its 7 days crossed no clock change
-- before the absolute bound, which caps the inactivity window.

ALTER TABLE auth.oauth_refresh_families
  DROP CONSTRAINT oauth_refresh_families_check1,
  DROP CONSTRAINT oauth_refresh_families_check2,
  ADD CONSTRAINT oauth_refresh_families_absolute_window
    CHECK (absolute_expires_at = auth.oauth_refresh_absolute_expires_at(created_at)),
  ADD CONSTRAINT oauth_refresh_families_inactivity_window
    CHECK (inactivity_expires_at <= auth.oauth_refresh_inactivity_expires_at(last_used_at, absolute_expires_at));
