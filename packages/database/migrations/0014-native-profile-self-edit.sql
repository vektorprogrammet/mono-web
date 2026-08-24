CREATE TABLE IF NOT EXISTS profile_self_edit_commands (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL,
  command_json jsonb NOT NULL,
  result_json jsonb NOT NULL,
  actor_person_id text NOT NULL REFERENCES person_profiles(person_id),
  expected_name_revision integer NOT NULL,
  expected_contact_revision integer NOT NULL,
  committed_name_revision integer NOT NULL,
  committed_contact_revision integer NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT profile_self_edit_commands_command_id CHECK (btrim(command_id) <> ''),
  CONSTRAINT profile_self_edit_commands_digest CHECK (
    command_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT profile_self_edit_commands_revisions CHECK (
    expected_name_revision >= 0
    AND expected_contact_revision >= 0
    AND committed_name_revision = expected_name_revision + 1
    AND committed_contact_revision = expected_contact_revision + 1
  ),
  CONSTRAINT profile_self_edit_commands_json_objects CHECK (
    jsonb_typeof(command_json) = 'object'
    AND jsonb_typeof(result_json) = 'object'
  ),
  CONSTRAINT profile_self_edit_commands_command_shape CHECK (
    command_json ?& ARRAY['firstName', 'lastName', 'email', 'phone']
    AND jsonb_typeof(command_json -> '_tag') = 'string'
    AND jsonb_typeof(command_json -> 'commandId') = 'string'
    AND jsonb_typeof(command_json -> 'actorPersonId') = 'string'
    AND (command_json ->> '_tag') IS NOT DISTINCT FROM 'UpdateOwnProfile'
    AND (command_json ->> 'commandId') IS NOT DISTINCT FROM command_id
    AND (command_json ->> 'actorPersonId') IS NOT DISTINCT FROM actor_person_id
    AND (command_json -> 'expectedNameRevision')
      IS NOT DISTINCT FROM to_jsonb(expected_name_revision)
    AND (command_json -> 'expectedContactRevision')
      IS NOT DISTINCT FROM to_jsonb(expected_contact_revision)
    AND jsonb_typeof(command_json -> 'firstName') = 'string'
    AND jsonb_typeof(command_json -> 'lastName') = 'string'
    AND jsonb_typeof(command_json -> 'email') = 'string'
    AND jsonb_typeof(command_json -> 'phone') = 'string'
    AND (
      command_json - ARRAY[
        'actorPersonId',
        '_tag',
        'commandId',
        'expectedNameRevision',
        'expectedContactRevision',
        'firstName',
        'lastName',
        'email',
        'phone'
      ]
    ) = '{}'::jsonb
  ),
  CONSTRAINT profile_self_edit_commands_result_shape CHECK (
    jsonb_typeof(result_json -> 'personId') = 'string'
    AND (result_json ->> 'personId') IS NOT DISTINCT FROM actor_person_id
    AND (result_json -> 'nameRevision')
      IS NOT DISTINCT FROM to_jsonb(committed_name_revision)
    AND (result_json -> 'contactRevision')
      IS NOT DISTINCT FROM to_jsonb(committed_contact_revision)
    AND (result_json -> 'firstName') IS NOT DISTINCT FROM (command_json -> 'firstName')
    AND (result_json -> 'lastName') IS NOT DISTINCT FROM (command_json -> 'lastName')
    AND (result_json -> 'email') IS NOT DISTINCT FROM (command_json -> 'email')
    AND (result_json -> 'phone') IS NOT DISTINCT FROM (command_json -> 'phone')
    AND (
      result_json - ARRAY[
        'personId',
        'firstName',
        'lastName',
        'email',
        'phone',
        'nameRevision',
        'contactRevision'
      ]
    ) = '{}'::jsonb
  )
);

CREATE INDEX IF NOT EXISTS profile_self_edit_commands_actor_commit_order
  ON profile_self_edit_commands (actor_person_id, committed_at, command_id);
CREATE UNIQUE INDEX IF NOT EXISTS profile_self_edit_commands_actor_name_revision
  ON profile_self_edit_commands (actor_person_id, committed_name_revision);
CREATE UNIQUE INDEX IF NOT EXISTS profile_self_edit_commands_actor_contact_revision
  ON profile_self_edit_commands (actor_person_id, committed_contact_revision);

CREATE OR REPLACE FUNCTION prevent_profile_self_edit_command_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Profile self-edit command audit rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profile_self_edit_commands_immutable
  ON profile_self_edit_commands;
CREATE TRIGGER profile_self_edit_commands_immutable
  BEFORE UPDATE OR DELETE ON profile_self_edit_commands
  FOR EACH ROW
  EXECUTE FUNCTION prevent_profile_self_edit_command_mutation();
