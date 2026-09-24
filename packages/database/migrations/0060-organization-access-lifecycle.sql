CREATE TABLE public.organization_national_boards (
  board_id text PRIMARY KEY CHECK (btrim(board_id) <> ''),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 250),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
ALTER TABLE public.organization_memberships
  ADD COLUMN board_id text REFERENCES public.organization_national_boards(board_id) ON DELETE RESTRICT,
  ADD COLUMN position_name text CHECK (position_name IS NULL OR char_length(btrim(position_name)) BETWEEN 1 AND 250),
  DROP CONSTRAINT organization_memberships_historical_team,
  ADD CONSTRAINT organization_memberships_target CHECK (
    (board_id IS NOT NULL AND team_id IS NULL AND deleted_team_name IS NULL AND NOT is_team_leader)
    OR (board_id IS NULL AND ((team_id IS NOT NULL AND deleted_team_name IS NULL)
      OR (team_id IS NULL AND deleted_team_name IS NOT NULL AND btrim(deleted_team_name) <> '')))
  );
DROP INDEX public.organization_memberships_live_identity_unique;
CREATE UNIQUE INDEX organization_memberships_live_identity_unique
  ON public.organization_memberships(person_id, team_id, start_at, position_id) NULLS NOT DISTINCT
  WHERE team_id IS NOT NULL AND position_id IS NOT NULL;
CREATE UNIQUE INDEX organization_memberships_native_position_unique
  ON public.organization_memberships(person_id, team_id, start_at, position_name) NULLS NOT DISTINCT
  WHERE team_id IS NOT NULL AND position_id IS NULL;
DROP INDEX public.organization_memberships_historical_identity_unique;
CREATE UNIQUE INDEX organization_memberships_historical_identity_unique
  ON public.organization_memberships(person_id, deleted_team_name, start_at, position_id) NULLS NOT DISTINCT
  WHERE team_id IS NULL AND board_id IS NULL;
CREATE UNIQUE INDEX organization_memberships_board_identity_unique
  ON public.organization_memberships(person_id, board_id, start_at, position_name) NULLS NOT DISTINCT
  WHERE board_id IS NOT NULL;

ALTER TABLE auth."user"
  ADD COLUMN access_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN access_revision integer NOT NULL DEFAULT 0 CHECK (access_revision >= 0);
ALTER TABLE auth."session" ADD COLUMN access_revision integer NOT NULL DEFAULT 0;
CREATE VIEW auth.usable_human_sessions AS
  SELECT s.* FROM auth."session" s JOIN auth."user" u ON u.id=s."userId"
  WHERE NOT u.access_disabled AND s.access_revision=u.access_revision AND s."expiresAt">CURRENT_TIMESTAMP;

-- INSERT has no existing session row lock. All issuance takes the same person lock
-- before it reads access state, so disable either sees the session or prevents it.
CREATE FUNCTION auth.guard_session_issuance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE disabled boolean; current_revision integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('vektorprogrammet:person-authorization:v1:' || NEW."userId", 0));
  SELECT access_disabled, access_revision INTO disabled, current_revision FROM auth."user" WHERE id=NEW."userId";
  IF disabled IS DISTINCT FROM false THEN RAISE EXCEPTION 'native account unavailable'; END IF;
  IF NEW.access_revision <> current_revision THEN RAISE EXCEPTION 'native account epoch changed'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION auth.guard_session_renewal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."expiresAt">OLD."expiresAt" AND NOT EXISTS(SELECT 1 FROM auth."user" u
    WHERE u.id=OLD."userId" AND NOT u.access_disabled AND u.access_revision=OLD.access_revision) THEN
    RAISE EXCEPTION 'native session cannot be renewed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_access_renewal BEFORE UPDATE OF "expiresAt" ON auth."session"
  FOR EACH ROW EXECUTE FUNCTION auth.guard_session_renewal();
CREATE TRIGGER session_access_issuance BEFORE INSERT ON auth."session"
  FOR EACH ROW EXECUTE FUNCTION auth.guard_session_issuance();

-- An UPDATE already holds its row lock; it must not acquire a person lock here.
-- Epoch validation on every credential read makes concurrent renewal harmless.
ALTER TABLE auth."account" ADD COLUMN access_revision integer NOT NULL DEFAULT 0;
CREATE FUNCTION auth.guard_credential_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('vektorprogrammet:person-authorization:v1:' || NEW."userId",0));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM auth."user" WHERE id=NEW."userId" AND NOT access_disabled AND access_revision=NEW.access_revision) THEN
    RAISE EXCEPTION 'native account unavailable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_access_write BEFORE INSERT OR UPDATE OF password ON auth."account"
  FOR EACH ROW EXECUTE FUNCTION auth.guard_credential_write();

CREATE FUNCTION auth.guard_human_token_issuance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE person text; source_session text;
BEGIN
  IF TG_TABLE_NAME IN ('oauthRefreshToken', 'oauthAccessToken') THEN
    person := NEW."userId"; source_session := NEW."sessionId";
  ELSE
    person := NEW.person_id; source_session := NEW.session_id;
  END IF;
  IF person IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('vektorprogrammet:person-authorization:v1:' || person, 0));
  IF NOT EXISTS(SELECT 1 FROM auth.usable_human_sessions s WHERE s."userId"=person AND s.id=source_session) THEN
    RAISE EXCEPTION 'native account unavailable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER oauth_refresh_access BEFORE INSERT ON auth."oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION auth.guard_human_token_issuance();
CREATE TRIGGER oauth_token_access BEFORE INSERT ON auth."oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION auth.guard_human_token_issuance();
CREATE TRIGGER oauth_family_access BEFORE INSERT ON auth.oauth_refresh_families FOR EACH ROW EXECUTE FUNCTION auth.guard_human_token_issuance();
CREATE TRIGGER oauth_state_access BEFORE INSERT ON auth.oauth_access_token_state FOR EACH ROW EXECUTE FUNCTION auth.guard_human_token_issuance();

CREATE TABLE public.organization_lifecycle_history (
  command_id text PRIMARY KEY,
  command_digest text NOT NULL,
  actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  subject_id text NOT NULL,
  target_kind text CHECK(target_kind IN ('Team','NationalBoard')),
  target_id text,
  action text NOT NULL CHECK(action IN ('Appoint','ReviseAppointment','EndAppointment','SuspendAppointment','ReinstateAppointment','CreateNationalBoard','ChangeAccountAccess')),
  reason text NOT NULL CHECK(char_length(btrim(reason)) BETWEEN 1 AND 250),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  before_json jsonb,
  after_json jsonb,
  result_json jsonb NOT NULL
);
CREATE FUNCTION public.organization_lifecycle_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'organization lifecycle history is append-only'; END $$;
CREATE TRIGGER organization_lifecycle_history_immutable BEFORE UPDATE OR DELETE ON public.organization_lifecycle_history
  FOR EACH ROW EXECUTE FUNCTION public.organization_lifecycle_history_immutable();
