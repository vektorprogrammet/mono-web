ALTER TABLE recruitment_invitations
  ADD COLUMN response_message text NULL,
  ADD COLUMN responded_at timestamptz NULL,
  ADD COLUMN response_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN superseded_at timestamptz NULL;

ALTER TABLE recruitment_invitations
  DROP CONSTRAINT recruitment_invitations_response_state;

ALTER TABLE recruitment_invitations
  ADD CONSTRAINT recruitment_invitations_response_state CHECK (
    response_state IN ('Pending', 'Accepted', 'Rejected', 'RequestedNewTime')
  ),
  ADD CONSTRAINT recruitment_invitations_response_message CHECK (
    response_message IS NULL OR (
      response_message = btrim(response_message)
      AND response_message <> ''
      AND char_length(response_message) <= 2000
    )
  ),
  ADD CONSTRAINT recruitment_invitations_response_consistency CHECK (
    (
      response_state = 'Pending'
      AND response_message IS NULL
      AND responded_at IS NULL
      AND response_revision = 0
    )
    OR (
      response_state = 'Accepted'
      AND response_message IS NULL
      AND responded_at IS NOT NULL
      AND response_revision = 1
    )
    OR (
      response_state = 'Rejected'
      AND responded_at IS NOT NULL
      AND response_revision = 1
    )
    OR (
      response_state = 'RequestedNewTime'
      AND response_message IS NOT NULL
      AND responded_at IS NOT NULL
      AND response_revision = 1
    )
  ),
  ADD CONSTRAINT recruitment_invitations_superseded_after_creation CHECK (
    superseded_at IS NULL OR superseded_at >= created_at
  ),
  ADD CONSTRAINT recruitment_invitations_response_link_unique
    UNIQUE (
      invitation_id,
      interview_id,
      schedule_revision,
      response_revision,
      response_state
    );

ALTER TABLE recruitment_invitations
  DROP CONSTRAINT recruitment_invitations_interview_unique;

CREATE UNIQUE INDEX recruitment_invitations_current_interview_unique
  ON recruitment_invitations (interview_id)
  WHERE superseded_at IS NULL;

CREATE TABLE recruitment_invitation_response_audit (
  invitation_id text PRIMARY KEY,
  interview_id text NOT NULL,
  schedule_revision integer NOT NULL,
  response_revision integer NOT NULL,
  response_state text NOT NULL,
  response_message text NULL,
  responded_at timestamptz NOT NULL,
  CONSTRAINT recruitment_invitation_response_audit_revision CHECK (response_revision = 1),
  CONSTRAINT recruitment_invitation_response_audit_state CHECK (
    response_state IN ('Accepted', 'Rejected', 'RequestedNewTime')
  ),
  CONSTRAINT recruitment_invitation_response_audit_message CHECK (
    (
      response_state = 'Accepted'
      AND response_message IS NULL
    )
    OR response_state = 'Rejected'
    OR (
      response_state = 'RequestedNewTime'
      AND response_message IS NOT NULL
    )
  ),
  CONSTRAINT recruitment_invitation_response_audit_message_value CHECK (
    response_message IS NULL OR (
      response_message = btrim(response_message)
      AND response_message <> ''
      AND char_length(response_message) <= 2000
    )
  ),
  CONSTRAINT recruitment_invitation_response_audit_link_unique
    UNIQUE (
      invitation_id,
      interview_id,
      schedule_revision,
      response_revision,
      response_state
    ),
  CONSTRAINT recruitment_invitation_response_audit_invitation_fk
    FOREIGN KEY (
      invitation_id,
      interview_id,
      schedule_revision,
      response_revision,
      response_state
    )
    REFERENCES recruitment_invitations(
      invitation_id,
      interview_id,
      schedule_revision,
      response_revision,
      response_state
    )
);

CREATE TABLE recruitment_invitation_response_outbox (
  effect_id text PRIMARY KEY,
  effect_type text NOT NULL CHECK (effect_type = 'SendInterviewInvitationResponse'),
  invitation_id text NOT NULL,
  interview_id text NOT NULL,
  schedule_revision integer NOT NULL,
  response_revision integer NOT NULL,
  response_state text NOT NULL,
  response_message text NULL,
  ordinal integer NOT NULL CHECK (ordinal = 0),
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Processing', 'Delivered', 'Failed', 'Quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_id text NULL,
  claimed_at timestamptz NULL,
  delivered_at timestamptz NULL,
  last_failure_tag text NULL,
  CONSTRAINT recruitment_invitation_response_outbox_id CHECK (
    effect_id = 'recruitment-invitation-response:' || invitation_id || ':' || response_revision::text
  ),
  CONSTRAINT recruitment_invitation_response_outbox_state CHECK (
    response_state IN ('Rejected', 'RequestedNewTime')
  ),
  CONSTRAINT recruitment_invitation_response_outbox_message CHECK (
    (
      response_state = 'Rejected'
      AND (
        response_message IS NULL OR (
          response_message = btrim(response_message)
          AND response_message <> ''
          AND char_length(response_message) <= 2000
        )
      )
    )
    OR (
      response_state = 'RequestedNewTime'
      AND response_message IS NOT NULL
      AND response_message = btrim(response_message)
      AND response_message <> ''
      AND char_length(response_message) <= 2000
    )
  ),
  CONSTRAINT recruitment_invitation_response_outbox_payload_object CHECK (
    jsonb_typeof(payload_json) = 'object'
  ),
  CONSTRAINT recruitment_invitation_response_outbox_payload_capability_absent CHECK (
    NOT (payload_json ?| ARRAY['responseCapability', 'capability', 'capabilitySha256'])
  ),
  CONSTRAINT recruitment_invitation_response_outbox_invitation_unique UNIQUE (invitation_id),
  CONSTRAINT recruitment_invitation_response_outbox_claim_check CHECK (
    (status = 'Processing' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status <> 'Processing' AND claim_id IS NULL AND claimed_at IS NULL)
  ),
  CONSTRAINT recruitment_invitation_response_outbox_audit_fk
    FOREIGN KEY (
      invitation_id,
      interview_id,
      schedule_revision,
      response_revision,
      response_state
    )
    REFERENCES recruitment_invitation_response_audit(
      invitation_id,
      interview_id,
      schedule_revision,
      response_revision,
      response_state
    )
);

CREATE UNIQUE INDEX recruitment_invitation_response_outbox_active_claim_unique
  ON recruitment_invitation_response_outbox (claim_id)
  WHERE claim_id IS NOT NULL;
CREATE INDEX recruitment_invitation_response_outbox_pending_order
  ON recruitment_invitation_response_outbox (status, invitation_id, ordinal);
