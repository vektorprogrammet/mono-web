CREATE TABLE IF NOT EXISTS person_contact_profiles (
  person_id text PRIMARY KEY REFERENCES person_profiles(person_id),
  email text NOT NULL,
  phone text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT person_contact_profiles_email_nonempty CHECK (btrim(email) <> ''),
  CONSTRAINT person_contact_profiles_email_length CHECK (char_length(email) <= 320),
  CONSTRAINT person_contact_profiles_phone_nonempty CHECK (btrim(phone) <> ''),
  CONSTRAINT person_contact_profiles_phone_length CHECK (char_length(phone) <= 32),
  CONSTRAINT person_contact_profiles_revision_nonnegative CHECK (revision >= 0)
);

ALTER TABLE recruitment_interviews
  DROP CONSTRAINT IF EXISTS recruitment_interviews_state_schedule_check;

ALTER TABLE recruitment_interviews
  DROP COLUMN IF EXISTS state,
  DROP COLUMN IF EXISTS scheduled_at;

CREATE TABLE IF NOT EXISTS recruitment_interview_schedules (
  interview_id text PRIMARY KEY REFERENCES recruitment_interviews(interview_id),
  scheduled_at timestamptz NOT NULL,
  room text NOT NULL,
  campus text NULL,
  map_link text NULL,
  message text NOT NULL,
  scheduled_by_person_id text NOT NULL REFERENCES person_profiles(person_id),
  committed_at timestamptz NOT NULL,
  schedule_revision integer NOT NULL,
  CONSTRAINT recruitment_interview_schedules_room_nonempty CHECK (btrim(room) <> ''),
  CONSTRAINT recruitment_interview_schedules_room_length CHECK (char_length(room) <= 250),
  CONSTRAINT recruitment_interview_schedules_campus_nonempty CHECK (
    campus IS NULL OR btrim(campus) <> ''
  ),
  CONSTRAINT recruitment_interview_schedules_campus_length CHECK (
    campus IS NULL OR char_length(campus) <= 250
  ),
  CONSTRAINT recruitment_interview_schedules_map_https CHECK (
    map_link IS NULL OR map_link ~ '^https://[^/@:]+(?:[/:?#]|$)'
  ),
  CONSTRAINT recruitment_interview_schedules_message_nonempty CHECK (btrim(message) <> ''),
  CONSTRAINT recruitment_interview_schedules_message_length CHECK (
    char_length(message) <= 2000
  ),
  CONSTRAINT recruitment_interview_schedules_revision_positive CHECK (schedule_revision > 0),
  CONSTRAINT recruitment_interview_schedules_interview_revision_unique
    UNIQUE (interview_id, schedule_revision)
);

CREATE TABLE IF NOT EXISTS recruitment_invitations (
  invitation_id text PRIMARY KEY,
  interview_id text NOT NULL,
  schedule_revision integer NOT NULL,
  capability_sha256 text NOT NULL UNIQUE,
  response_state text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT recruitment_invitations_id_nonempty CHECK (btrim(invitation_id) <> ''),
  CONSTRAINT recruitment_invitations_digest CHECK (capability_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT recruitment_invitations_response_state CHECK (response_state = 'Pending'),
  CONSTRAINT recruitment_invitations_interview_unique UNIQUE (interview_id),
  CONSTRAINT recruitment_invitations_interview_revision_unique
    UNIQUE (interview_id, schedule_revision),
  CONSTRAINT recruitment_invitations_link_unique
    UNIQUE (invitation_id, interview_id, schedule_revision),
  CONSTRAINT recruitment_invitations_schedule_fk
    FOREIGN KEY (interview_id, schedule_revision)
    REFERENCES recruitment_interview_schedules(interview_id, schedule_revision)
);

CREATE TABLE IF NOT EXISTS recruitment_schedule_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL,
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  interview_id text NOT NULL,
  schedule_revision integer NOT NULL,
  committed_at timestamptz NOT NULL,
  CONSTRAINT recruitment_schedule_receipts_id_nonempty CHECK (btrim(command_id) <> ''),
  CONSTRAINT recruitment_schedule_receipts_digest CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT recruitment_schedule_receipts_interview_unique UNIQUE (interview_id),
  CONSTRAINT recruitment_schedule_receipts_link_unique
    UNIQUE (command_id, interview_id, schedule_revision),
  CONSTRAINT recruitment_schedule_receipts_schedule_fk
    FOREIGN KEY (interview_id, schedule_revision)
    REFERENCES recruitment_interview_schedules(interview_id, schedule_revision)
);

CREATE TABLE IF NOT EXISTS recruitment_schedule_audit (
  command_id text PRIMARY KEY,
  interview_id text NOT NULL,
  schedule_revision integer NOT NULL,
  actor_person_id text NOT NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT recruitment_schedule_audit_actor_nonempty CHECK (btrim(actor_person_id) <> ''),
  CONSTRAINT recruitment_schedule_audit_action CHECK (action = 'InterviewScheduled'),
  CONSTRAINT recruitment_schedule_audit_receipt_fk
    FOREIGN KEY (command_id, interview_id, schedule_revision)
    REFERENCES recruitment_schedule_command_receipts(command_id, interview_id, schedule_revision),
  CONSTRAINT recruitment_schedule_audit_schedule_fk
    FOREIGN KEY (interview_id, schedule_revision)
    REFERENCES recruitment_interview_schedules(interview_id, schedule_revision)
);

CREATE TABLE IF NOT EXISTS recruitment_invitation_outbox (
  effect_id text PRIMARY KEY,
  effect_type text NOT NULL CHECK (effect_type = 'SendInterviewInvitation'),
  command_id text NOT NULL,
  interview_id text NOT NULL,
  invitation_id text NOT NULL,
  schedule_revision integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal = 0),
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Processing', 'Delivered', 'Failed', 'Quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_id text NULL,
  claimed_at timestamptz NULL,
  delivered_at timestamptz NULL,
  last_failure_tag text NULL,
  CONSTRAINT recruitment_invitation_outbox_id_nonempty CHECK (btrim(effect_id) <> ''),
  CONSTRAINT recruitment_invitation_outbox_command_order_unique UNIQUE (command_id, ordinal),
  CONSTRAINT recruitment_invitation_outbox_invitation_unique UNIQUE (invitation_id),
  CONSTRAINT recruitment_invitation_outbox_claim_check CHECK (
    (status = 'Processing' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'Processing' AND claim_id IS NULL AND claimed_at IS NULL)
  ),
  CONSTRAINT recruitment_invitation_outbox_receipt_fk
    FOREIGN KEY (command_id, interview_id, schedule_revision)
    REFERENCES recruitment_schedule_command_receipts(command_id, interview_id, schedule_revision),
  CONSTRAINT recruitment_invitation_outbox_invitation_fk
    FOREIGN KEY (invitation_id, interview_id, schedule_revision)
    REFERENCES recruitment_invitations(invitation_id, interview_id, schedule_revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS recruitment_invitation_outbox_active_claim_unique
  ON recruitment_invitation_outbox (claim_id)
  WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recruitment_invitation_outbox_pending_order
  ON recruitment_invitation_outbox (status, command_id, ordinal);
CREATE INDEX IF NOT EXISTS recruitment_interview_schedules_order
  ON recruitment_interview_schedules (scheduled_at, interview_id);
