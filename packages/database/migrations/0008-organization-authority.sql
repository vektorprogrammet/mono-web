CREATE TABLE IF NOT EXISTS organization_departments (
  department_id text PRIMARY KEY,
  name text NOT NULL,
  short_name text NOT NULL,
  email text NOT NULL,
  address text NULL,
  city text NOT NULL,
  latitude text NULL,
  longitude text NULL,
  slack_channel text NULL,
  logo_path text NULL,
  active boolean NOT NULL DEFAULT TRUE,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT organization_departments_id_nonempty CHECK (btrim(department_id) <> ''),
  CONSTRAINT organization_departments_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT organization_departments_short_name_nonempty CHECK (btrim(short_name) <> ''),
  CONSTRAINT organization_departments_email_nonempty CHECK (btrim(email) <> ''),
  CONSTRAINT organization_departments_city_nonempty CHECK (btrim(city) <> ''),
  CONSTRAINT organization_departments_revision_nonnegative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS organization_teams (
  team_id text PRIMARY KEY,
  department_id text NOT NULL REFERENCES organization_departments(department_id),
  name text NOT NULL,
  email text NULL,
  description text NULL,
  short_description text NULL,
  accept_application boolean NULL,
  deadline timestamptz NULL,
  active boolean NOT NULL DEFAULT TRUE,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT organization_teams_id_nonempty CHECK (btrim(team_id) <> ''),
  CONSTRAINT organization_teams_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT organization_teams_revision_nonnegative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  membership_id text PRIMARY KEY,
  person_id text NOT NULL,
  team_id text NULL REFERENCES organization_teams(team_id) ON DELETE SET NULL,
  deleted_team_name text NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NULL,
  position_id text NULL,
  is_team_leader boolean NOT NULL DEFAULT FALSE,
  is_suspended boolean NOT NULL DEFAULT FALSE,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT organization_memberships_id_nonempty CHECK (btrim(membership_id) <> ''),
  CONSTRAINT organization_memberships_person_nonempty CHECK (btrim(person_id) <> ''),
  CONSTRAINT organization_memberships_position_nonempty CHECK (position_id IS NULL OR btrim(position_id) <> ''),
  CONSTRAINT organization_memberships_interval_ordered CHECK (end_at IS NULL OR end_at > start_at),
  CONSTRAINT organization_memberships_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT organization_memberships_historical_team CHECK (
    (team_id IS NOT NULL AND deleted_team_name IS NULL)
    OR (team_id IS NULL AND deleted_team_name IS NOT NULL AND btrim(deleted_team_name) <> '')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_memberships_live_identity_unique
  ON organization_memberships (person_id, team_id, start_at, position_id) NULLS NOT DISTINCT
  WHERE team_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organization_memberships_historical_identity_unique
  ON organization_memberships (person_id, deleted_team_name, start_at, position_id) NULLS NOT DISTINCT
  WHERE team_id IS NULL;

CREATE INDEX IF NOT EXISTS organization_teams_department_order
  ON organization_teams (department_id, team_id);

CREATE INDEX IF NOT EXISTS organization_memberships_team_interval_order
  ON organization_memberships (team_id, start_at, membership_id);

CREATE INDEX IF NOT EXISTS organization_memberships_historical_interval_order
  ON organization_memberships (start_at, membership_id)
  WHERE team_id IS NULL;

CREATE TABLE IF NOT EXISTS organization_membership_quarantine (
  source_repository text NOT NULL,
  source_revision text NOT NULL,
  snapshot_id text NOT NULL,
  source_kind text NOT NULL,
  source_primary_key text NOT NULL,
  source_occurrence integer NOT NULL CHECK (source_occurrence >= 0),
  transformation_revision text NOT NULL,
  target_semantic_identity text NOT NULL,
  reason text NOT NULL,
  raw_json jsonb NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_membership_quarantine_source_kind CHECK (source_kind IN ('department', 'team', 'membership')),
  CONSTRAINT organization_membership_quarantine_reason_nonempty CHECK (btrim(reason) <> ''),
  PRIMARY KEY (
    source_repository,
    source_revision,
    snapshot_id,
    source_kind,
    source_primary_key,
    source_occurrence,
    transformation_revision
  )
);

CREATE TABLE IF NOT EXISTS organization_import_ledger (
  source_repository text NOT NULL,
  source_revision text NOT NULL,
  snapshot_id text NOT NULL,
  source_kind text NOT NULL,
  source_primary_key text NOT NULL,
  source_occurrence integer NOT NULL CHECK (source_occurrence >= 0),
  transformation_revision text NOT NULL,
  target_semantic_identity text NOT NULL,
  destination_identity text NULL,
  result text NOT NULL,
  reason_json jsonb NULL,
  source_metadata_json jsonb NULL,
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_import_ledger_source_kind CHECK (source_kind IN ('department', 'team', 'membership')),
  CONSTRAINT organization_import_ledger_result CHECK (result IN ('Accepted', 'Quarantined')),
  CONSTRAINT organization_import_ledger_reason CHECK (
    (result = 'Accepted' AND reason_json IS NULL)
    OR (result = 'Quarantined' AND reason_json IS NOT NULL)
  ),
  PRIMARY KEY (
    source_repository,
    source_revision,
    snapshot_id,
    source_kind,
    source_primary_key,
    source_occurrence,
    transformation_revision
  )
);

CREATE OR REPLACE FUNCTION organization_capture_deleted_team_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE organization_memberships
  SET deleted_team_name = OLD.name
  WHERE team_id = OLD.team_id
    AND deleted_team_name IS NULL;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS organization_capture_deleted_team_name ON organization_teams;
CREATE TRIGGER organization_capture_deleted_team_name
BEFORE DELETE ON organization_teams
FOR EACH ROW
EXECUTE FUNCTION organization_capture_deleted_team_name();
