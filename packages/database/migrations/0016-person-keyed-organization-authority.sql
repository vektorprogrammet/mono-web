CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS organization_global_administrator_grants (
  grant_id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES person_profiles(person_id) ON DELETE RESTRICT,
  start_at timestamptz NOT NULL,
  end_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT organization_global_administrator_grants_id_nonempty CHECK (
    btrim(grant_id) <> ''
  ),
  CONSTRAINT organization_global_administrator_grants_interval_ordered CHECK (
    end_at IS NULL OR end_at > start_at
  ),
  CONSTRAINT organization_global_administrator_grants_revision_nonnegative CHECK (
    revision >= 0
  ),
  CONSTRAINT organization_global_administrator_grants_no_overlap
    EXCLUDE USING gist (
      person_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
);

CREATE INDEX IF NOT EXISTS organization_global_administrator_grants_person_order
  ON organization_global_administrator_grants (person_id, start_at, grant_id);
