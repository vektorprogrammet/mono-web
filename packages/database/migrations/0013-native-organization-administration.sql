ALTER TABLE organization_departments
  ADD COLUMN IF NOT EXISTS native_creation_command_id text NULL;

ALTER TABLE organization_teams
  ADD COLUMN IF NOT EXISTS native_creation_command_id text NULL;

CREATE TABLE IF NOT EXISTS organization_field_of_studies (
  field_of_study_id text PRIMARY KEY,
  name text NOT NULL,
  short_name text NOT NULL,
  department_id text NULL REFERENCES organization_departments(department_id),
  active boolean NOT NULL DEFAULT TRUE,
  revision integer NOT NULL DEFAULT 0,
  native_creation_command_id text NOT NULL,
  CONSTRAINT organization_field_of_studies_id CHECK (
    field_of_study_id ~ '^field-of-study-[a-f0-9]{64}$'
  ),
  CONSTRAINT organization_field_of_studies_name CHECK (
    btrim(name) <> '' AND char_length(name) <= 250
  ),
  CONSTRAINT organization_field_of_studies_short_name CHECK (
    btrim(short_name) <> '' AND char_length(short_name) <= 50
  ),
  CONSTRAINT organization_field_of_studies_revision CHECK (revision >= 0),
  CONSTRAINT organization_field_of_studies_creation_command CHECK (
    btrim(native_creation_command_id) <> ''
  )
);

CREATE TABLE IF NOT EXISTS organization_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL,
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  actor_json jsonb NOT NULL,
  actor_person_id text NOT NULL,
  committed_at timestamptz NOT NULL,
  CONSTRAINT organization_command_receipts_command_id CHECK (btrim(command_id) <> ''),
  CONSTRAINT organization_command_receipts_digest CHECK (
    command_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT organization_command_receipts_entity_kind CHECK (
    entity_kind IN ('Department', 'Team', 'FieldOfStudy')
  ),
  CONSTRAINT organization_command_receipts_entity_id CHECK (
    (entity_kind = 'Department' AND entity_id ~ '^department-[a-f0-9]{64}$')
    OR (entity_kind = 'Team' AND entity_id ~ '^team-[a-f0-9]{64}$')
    OR (entity_kind = 'FieldOfStudy' AND entity_id ~ '^field-of-study-[a-f0-9]{64}$')
  ),
  CONSTRAINT organization_command_receipts_json_objects CHECK (
    jsonb_typeof(command_json) = 'object'
    AND jsonb_typeof(observation_json) = 'object'
    AND jsonb_typeof(actor_json) = 'object'
  ),
  CONSTRAINT organization_command_receipts_command_link CHECK (
    (command_json ->> 'commandId') IS NOT DISTINCT FROM command_id
    AND (command_json ->> '_tag') IS NOT DISTINCT FROM ('Create' || entity_kind)
  ),
  CONSTRAINT organization_command_receipts_actor_link CHECK (
    (actor_json ->> '_tag') IS NOT DISTINCT FROM 'OrganizationAdministrator'
    AND (actor_json ->> 'personId') IS NOT DISTINCT FROM actor_person_id
    AND btrim(actor_person_id) <> ''
  ),
  CONSTRAINT organization_command_receipts_observation_link CHECK (
    (observation_json ->> 'commandId') IS NOT DISTINCT FROM command_id
    AND (observation_json ->> '_tag') IS NOT DISTINCT FROM (entity_kind || 'Created')
    AND (
      (entity_kind = 'Department'
        AND (observation_json #>> '{department,departmentId}')
          IS NOT DISTINCT FROM entity_id)
      OR (entity_kind = 'Team'
        AND (observation_json #>> '{team,teamId}') IS NOT DISTINCT FROM entity_id)
      OR (entity_kind = 'FieldOfStudy'
        AND (observation_json #>> '{fieldOfStudy,fieldOfStudyId}')
          IS NOT DISTINCT FROM entity_id)
    )
  ),
  CONSTRAINT organization_command_receipts_entity_unique UNIQUE (entity_kind, entity_id),
  CONSTRAINT organization_command_receipts_audit_link_unique UNIQUE (
    command_id,
    entity_kind,
    entity_id,
    actor_person_id,
    committed_at
  )
);

CREATE TABLE IF NOT EXISTS organization_creation_audit (
  command_id text PRIMARY KEY,
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  actor_person_id text NOT NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT organization_creation_audit_kind CHECK (
    entity_kind IN ('Department', 'Team', 'FieldOfStudy')
  ),
  CONSTRAINT organization_creation_audit_action CHECK (
    action = entity_kind || 'Created'
  ),
  CONSTRAINT organization_creation_audit_receipt_fk
    FOREIGN KEY (
      command_id,
      entity_kind,
      entity_id,
      actor_person_id,
      occurred_at
    )
    REFERENCES organization_command_receipts (
      command_id,
      entity_kind,
      entity_id,
      actor_person_id,
      committed_at
    )
    DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_departments_native_creation_unique
  ON organization_departments (native_creation_command_id)
  WHERE native_creation_command_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organization_teams_native_creation_unique
  ON organization_teams (native_creation_command_id)
  WHERE native_creation_command_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organization_field_of_studies_native_creation_unique
  ON organization_field_of_studies (native_creation_command_id);
CREATE INDEX IF NOT EXISTS organization_field_of_studies_department_order
  ON organization_field_of_studies (department_id, field_of_study_id);
CREATE INDEX IF NOT EXISTS organization_command_receipts_commit_order
  ON organization_command_receipts (committed_at, command_id);
CREATE INDEX IF NOT EXISTS organization_creation_audit_entity_order
  ON organization_creation_audit (entity_kind, entity_id, command_id);

ALTER TABLE organization_departments
  DROP CONSTRAINT IF EXISTS organization_departments_native_creation_shape;
ALTER TABLE organization_departments
  ADD CONSTRAINT organization_departments_native_creation_shape CHECK (
    native_creation_command_id IS NULL
    OR (
      btrim(native_creation_command_id) <> ''
      AND department_id ~ '^department-[a-f0-9]{64}$'
    )
  );

ALTER TABLE organization_teams
  DROP CONSTRAINT IF EXISTS organization_teams_native_creation_shape;
ALTER TABLE organization_teams
  ADD CONSTRAINT organization_teams_native_creation_shape CHECK (
    native_creation_command_id IS NULL
    OR (
      btrim(native_creation_command_id) <> ''
      AND team_id ~ '^team-[a-f0-9]{64}$'
    )
  );

ALTER TABLE organization_departments
  DROP CONSTRAINT IF EXISTS organization_departments_native_creation_receipt_fk;
ALTER TABLE organization_departments
  ADD CONSTRAINT organization_departments_native_creation_receipt_fk
    FOREIGN KEY (native_creation_command_id)
    REFERENCES organization_command_receipts(command_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE organization_teams
  DROP CONSTRAINT IF EXISTS organization_teams_native_creation_receipt_fk;
ALTER TABLE organization_teams
  ADD CONSTRAINT organization_teams_native_creation_receipt_fk
    FOREIGN KEY (native_creation_command_id)
    REFERENCES organization_command_receipts(command_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE organization_field_of_studies
  DROP CONSTRAINT IF EXISTS organization_field_of_studies_native_creation_receipt_fk;
ALTER TABLE organization_field_of_studies
  ADD CONSTRAINT organization_field_of_studies_native_creation_receipt_fk
    FOREIGN KEY (native_creation_command_id)
    REFERENCES organization_command_receipts(command_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION assert_organization_creation_links(
  target_command_id text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_row organization_command_receipts%ROWTYPE;
  receipt_found boolean;
  entity_count integer;
  matching_entity_count integer;
  audit_count integer;
  matching_audit_count integer;
BEGIN
  IF target_command_id IS NULL THEN
    RETURN;
  END IF;

  SELECT *
  INTO receipt_row
  FROM organization_command_receipts
  WHERE command_id = target_command_id;
  receipt_found := FOUND;

  SELECT
    (SELECT count(*) FROM organization_departments
      WHERE native_creation_command_id = target_command_id)
    + (SELECT count(*) FROM organization_teams
      WHERE native_creation_command_id = target_command_id)
    + (SELECT count(*) FROM organization_field_of_studies
      WHERE native_creation_command_id = target_command_id)
  INTO entity_count;

  SELECT count(*)
  INTO audit_count
  FROM organization_creation_audit
  WHERE command_id = target_command_id;

  IF NOT receipt_found THEN
    IF entity_count <> 0 OR audit_count <> 0 THEN
      RAISE EXCEPTION 'Organization creation provenance has no command receipt';
    END IF;
    RETURN;
  END IF;

  IF receipt_row.entity_kind = 'Department' THEN
    SELECT count(*)
    INTO matching_entity_count
    FROM organization_departments
    WHERE native_creation_command_id = target_command_id
      AND department_id = receipt_row.entity_id;
  ELSIF receipt_row.entity_kind = 'Team' THEN
    SELECT count(*)
    INTO matching_entity_count
    FROM organization_teams
    WHERE native_creation_command_id = target_command_id
      AND team_id = receipt_row.entity_id;
  ELSIF receipt_row.entity_kind = 'FieldOfStudy' THEN
    SELECT count(*)
    INTO matching_entity_count
    FROM organization_field_of_studies
    WHERE native_creation_command_id = target_command_id
      AND field_of_study_id = receipt_row.entity_id;
  ELSE
    matching_entity_count := 0;
  END IF;

  SELECT count(*)
  INTO matching_audit_count
  FROM organization_creation_audit AS audit
  WHERE audit.command_id = target_command_id
    AND audit.entity_kind = receipt_row.entity_kind
    AND audit.entity_id = receipt_row.entity_id
    AND audit.actor_person_id = receipt_row.actor_person_id
    AND audit.action = receipt_row.entity_kind || 'Created'
    AND audit.occurred_at = receipt_row.committed_at;

  IF entity_count <> 1 OR matching_entity_count <> 1 THEN
    RAISE EXCEPTION 'Organization command receipt does not link exactly one canonical entity';
  END IF;
  IF audit_count <> 1 OR matching_audit_count <> 1 THEN
    RAISE EXCEPTION 'Organization command receipt does not link exactly one audit fact';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_organization_creation_links()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_command_id text;
  new_command_id text;
  command_field text;
BEGIN
  command_field := CASE
    WHEN TG_TABLE_NAME IN (
      'organization_departments',
      'organization_teams',
      'organization_field_of_studies'
    ) THEN 'native_creation_command_id'
    ELSE 'command_id'
  END;

  IF TG_OP <> 'INSERT' THEN
    old_command_id := to_jsonb(OLD) ->> command_field;
    PERFORM assert_organization_creation_links(old_command_id);
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_command_id := to_jsonb(NEW) ->> command_field;
    IF new_command_id IS DISTINCT FROM old_command_id THEN
      PERFORM assert_organization_creation_links(new_command_id);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS organization_departments_creation_links
  ON organization_departments;
CREATE CONSTRAINT TRIGGER organization_departments_creation_links
  AFTER INSERT OR UPDATE OR DELETE ON organization_departments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_organization_creation_links();

DROP TRIGGER IF EXISTS organization_teams_creation_links
  ON organization_teams;
CREATE CONSTRAINT TRIGGER organization_teams_creation_links
  AFTER INSERT OR UPDATE OR DELETE ON organization_teams
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_organization_creation_links();

DROP TRIGGER IF EXISTS organization_field_of_studies_creation_links
  ON organization_field_of_studies;
CREATE CONSTRAINT TRIGGER organization_field_of_studies_creation_links
  AFTER INSERT OR UPDATE OR DELETE ON organization_field_of_studies
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_organization_creation_links();

DROP TRIGGER IF EXISTS organization_command_receipts_creation_links
  ON organization_command_receipts;
CREATE CONSTRAINT TRIGGER organization_command_receipts_creation_links
  AFTER INSERT OR UPDATE OR DELETE ON organization_command_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_organization_creation_links();

DROP TRIGGER IF EXISTS organization_creation_audit_links
  ON organization_creation_audit;
CREATE CONSTRAINT TRIGGER organization_creation_audit_links
  AFTER INSERT OR UPDATE OR DELETE ON organization_creation_audit
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_organization_creation_links();
