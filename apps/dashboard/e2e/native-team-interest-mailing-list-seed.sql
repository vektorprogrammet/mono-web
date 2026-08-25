-- name: seed_departments
INSERT INTO organization_departments (
  department_id,
  name,
  short_name,
  email,
  city,
  active,
  revision
)
SELECT
  seed_row.department_id,
  seed_row.name,
  seed_row.short_name,
  seed_row.email,
  seed_row.city,
  seed_row.active,
  seed_row.revision
FROM jsonb_to_recordset($1::jsonb) AS seed_row(
  department_id text,
  name text,
  short_name text,
  email text,
  city text,
  active boolean,
  revision integer
)
WHERE TRUE
ON CONFLICT (department_id) DO NOTHING;

-- name: seed_teams
INSERT INTO organization_teams (
  team_id,
  department_id,
  name,
  active,
  revision
)
SELECT
  seed_row.team_id,
  seed_row.department_id,
  seed_row.name,
  seed_row.active,
  seed_row.revision
FROM jsonb_to_recordset($1::jsonb) AS seed_row(
  team_id text,
  department_id text,
  name text,
  active boolean,
  revision integer
)
WHERE TRUE
ON CONFLICT (team_id) DO NOTHING;

-- name: seed_person_profiles
INSERT INTO person_profiles (
  person_id,
  first_name,
  last_name,
  revision
)
SELECT
  seed_row.person_id,
  seed_row.first_name,
  seed_row.last_name,
  seed_row.revision
FROM jsonb_to_recordset($1::jsonb) AS seed_row(
  person_id text,
  first_name text,
  last_name text,
  revision integer
)
WHERE TRUE
ON CONFLICT (person_id) DO NOTHING;

-- name: seed_person_contact_profiles
INSERT INTO person_contact_profiles (
  person_id,
  email,
  phone,
  revision
)
SELECT
  seed_row.person_id,
  seed_row.email,
  seed_row.phone,
  seed_row.revision
FROM jsonb_to_recordset($1::jsonb) AS seed_row(
  person_id text,
  email text,
  phone text,
  revision integer
)
WHERE TRUE
ON CONFLICT (person_id) DO NOTHING;

-- name: seed_memberships
INSERT INTO organization_memberships (
  membership_id,
  person_id,
  team_id,
  deleted_team_name,
  start_at,
  end_at,
  position_id,
  is_team_leader,
  is_suspended,
  revision
)
SELECT
  seed_row.membership_id,
  seed_row.person_id,
  seed_row.team_id,
  seed_row.deleted_team_name,
  seed_row.start_at,
  seed_row.end_at,
  seed_row.position_id,
  seed_row.is_team_leader,
  seed_row.is_suspended,
  seed_row.revision
FROM jsonb_to_recordset($1::jsonb) AS seed_row(
  membership_id text,
  person_id text,
  team_id text,
  deleted_team_name text,
  start_at timestamptz,
  end_at timestamptz,
  position_id text,
  is_team_leader boolean,
  is_suspended boolean,
  revision integer
)
WHERE TRUE
ON CONFLICT (membership_id) DO NOTHING;

-- name: seed_global_administrator_grants
INSERT INTO organization_global_administrator_grants (
  grant_id,
  person_id,
  start_at,
  end_at,
  revision
)
SELECT
  seed_row.grant_id,
  seed_row.person_id,
  seed_row.start_at,
  seed_row.end_at,
  seed_row.revision
FROM jsonb_to_recordset($1::jsonb) AS seed_row(
  grant_id text,
  person_id text,
  start_at timestamptz,
  end_at timestamptz,
  revision integer
)
WHERE TRUE
ON CONFLICT (grant_id) DO NOTHING;

-- name: seed_team_interest_registrations
INSERT INTO organization_team_interest_registrations (
  submitter_name,
  submitter_email,
  team_id,
  department_id,
  semester_id,
  submitted_at,
  revision
)
SELECT
  seed_row.submitter_name,
  seed_row.submitter_email,
  seed_row.team_id,
  seed_row.department_id,
  seed_row.semester_id,
  seed_row.submitted_at,
  seed_row.revision
FROM jsonb_to_recordset($1::jsonb) AS seed_row(
  submitter_name text,
  submitter_email text,
  team_id text,
  department_id text,
  semester_id text,
  submitted_at timestamptz,
  revision integer
);
