ALTER TABLE recruitment_invitations
  ADD COLUMN IF NOT EXISTS response_message text NULL,
  ADD COLUMN IF NOT EXISTS responded_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS response_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz NULL;

ALTER TABLE recruitment_invitations
  DROP CONSTRAINT IF EXISTS recruitment_invitations_response_state,
  DROP CONSTRAINT IF EXISTS recruitment_invitations_response_message,
  DROP CONSTRAINT IF EXISTS recruitment_invitations_response_consistency,
  DROP CONSTRAINT IF EXISTS recruitment_invitations_superseded_after_creation;

ALTER TABLE recruitment_invitations
  ADD CONSTRAINT recruitment_invitations_response_state CHECK (
    response_state IN ('Pending', 'Accepted', 'Rejected', 'RequestedNewTime')
  ),
  ADD CONSTRAINT recruitment_invitations_response_message CHECK (
    response_message IS NULL OR (
      response_message = btrim(response_message)
      AND response_message <> ''
      AND char_length(response_message) <= 2000
      AND response_message !~ '[A-Za-z0-9_-]{43}'
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
  );

ALTER TABLE recruitment_invitations
  DROP CONSTRAINT IF EXISTS recruitment_invitations_interview_unique;

CREATE UNIQUE INDEX IF NOT EXISTS recruitment_invitations_current_interview_unique
  ON recruitment_invitations (interview_id)
  WHERE superseded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS recruitment_invitations_response_link_unique
  ON recruitment_invitations (
    invitation_id,
    interview_id,
    schedule_revision,
    response_revision,
    response_state
  );

CREATE TABLE IF NOT EXISTS recruitment_invitation_response_audit (
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
      AND response_message !~ '[A-Za-z0-9_-]{43}'
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

CREATE TABLE IF NOT EXISTS recruitment_invitation_response_outbox (
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
          AND response_message !~ '[A-Za-z0-9_-]{43}'
        )
      )
    )
    OR (
      response_state = 'RequestedNewTime'
      AND response_message IS NOT NULL
      AND response_message = btrim(response_message)
      AND response_message <> ''
      AND char_length(response_message) <= 2000
      AND response_message !~ '[A-Za-z0-9_-]{43}'
    )
  ),
  CONSTRAINT recruitment_invitation_response_outbox_payload_object CHECK (
    jsonb_typeof(payload_json) = 'object'
  ),
  CONSTRAINT recruitment_invitation_response_outbox_payload_capability_absent CHECK (
    NOT (payload_json ?| ARRAY['responseCapability', 'capability', 'capabilitySha256'])
  ),
  CONSTRAINT recruitment_invitation_response_outbox_payload_confinement CHECK (
    payload_json::text !~ '[A-Za-z0-9_-]{43}'
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

ALTER TABLE recruitment_invitation_response_audit
  DROP CONSTRAINT IF EXISTS recruitment_invitation_response_audit_message_value;

ALTER TABLE recruitment_invitation_response_audit
  ADD CONSTRAINT recruitment_invitation_response_audit_message_value CHECK (
    response_message IS NULL OR (
      response_message = btrim(response_message)
      AND response_message <> ''
      AND char_length(response_message) <= 2000
      AND response_message !~ '[A-Za-z0-9_-]{43}'
    )
  );

ALTER TABLE recruitment_invitation_response_outbox
  DROP CONSTRAINT IF EXISTS recruitment_invitation_response_outbox_message,
  DROP CONSTRAINT IF EXISTS recruitment_invitation_response_outbox_payload_confinement;

ALTER TABLE recruitment_invitation_response_outbox
  ADD CONSTRAINT recruitment_invitation_response_outbox_message CHECK (
    (
      response_state = 'Rejected'
      AND (
        response_message IS NULL OR (
          response_message = btrim(response_message)
          AND response_message <> ''
          AND char_length(response_message) <= 2000
          AND response_message !~ '[A-Za-z0-9_-]{43}'
        )
      )
    )
    OR (
      response_state = 'RequestedNewTime'
      AND response_message IS NOT NULL
      AND response_message = btrim(response_message)
      AND response_message <> ''
      AND char_length(response_message) <= 2000
      AND response_message !~ '[A-Za-z0-9_-]{43}'
    )
  ),
  ADD CONSTRAINT recruitment_invitation_response_outbox_payload_confinement CHECK (
    payload_json::text !~ '[A-Za-z0-9_-]{43}'
  );

CREATE UNIQUE INDEX IF NOT EXISTS recruitment_invitation_response_outbox_active_claim_unique
  ON recruitment_invitation_response_outbox (claim_id)
  WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recruitment_invitation_response_outbox_pending_order
  ON recruitment_invitation_response_outbox (status, invitation_id, ordinal);

CREATE OR REPLACE FUNCTION assert_recruitment_invitation_response_links(
  target_invitation_id text
) RETURNS void AS $$
DECLARE
  invitation_row recruitment_invitations%ROWTYPE;
  matching_audit_count integer;
  total_audit_count integer;
  matching_outbox_count integer;
  total_outbox_count integer;
BEGIN
  SELECT *
  INTO invitation_row
  FROM recruitment_invitations
  WHERE invitation_id = target_invitation_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE audit.interview_id = invitation_row.interview_id
        AND audit.schedule_revision = invitation_row.schedule_revision
        AND audit.response_revision = invitation_row.response_revision
        AND audit.response_state = invitation_row.response_state
        AND audit.response_message IS NOT DISTINCT FROM invitation_row.response_message
        AND audit.responded_at = invitation_row.responded_at
    )::integer
  INTO total_audit_count, matching_audit_count
  FROM recruitment_invitation_response_audit AS audit
  WHERE audit.invitation_id = target_invitation_id;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE outbox.interview_id = invitation_row.interview_id
        AND outbox.schedule_revision = invitation_row.schedule_revision
        AND outbox.response_revision = invitation_row.response_revision
        AND outbox.response_state = invitation_row.response_state
        AND outbox.response_message IS NOT DISTINCT FROM invitation_row.response_message
    )::integer
  INTO total_outbox_count, matching_outbox_count
  FROM recruitment_invitation_response_outbox AS outbox
  WHERE outbox.invitation_id = target_invitation_id;

  IF invitation_row.response_state = 'Pending' THEN
    IF total_audit_count <> 0 OR total_outbox_count <> 0 THEN
      RAISE EXCEPTION 'Pending invitation response cannot have audit or outbox rows';
    END IF;
    RETURN;
  END IF;

  IF total_audit_count <> 1 OR matching_audit_count <> 1 THEN
    RAISE EXCEPTION 'Invitation response requires one matching audit row';
  END IF;

  IF invitation_row.response_state = 'Accepted' THEN
    IF total_outbox_count <> 0 THEN
      RAISE EXCEPTION 'Accepted invitation response cannot have an outbox row';
    END IF;
  ELSIF total_outbox_count <> 1 OR matching_outbox_count <> 1 THEN
    RAISE EXCEPTION 'Invitation response requires one matching outbox row';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_recruitment_invitation_response_links()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_recruitment_invitation_response_links(OLD.invitation_id);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM assert_recruitment_invitation_response_links(NEW.invitation_id);
  ELSE
    PERFORM assert_recruitment_invitation_response_links(OLD.invitation_id);
    IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id THEN
      PERFORM assert_recruitment_invitation_response_links(NEW.invitation_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recruitment_invitations_response_links
  ON recruitment_invitations;
CREATE CONSTRAINT TRIGGER recruitment_invitations_response_links
  AFTER INSERT OR UPDATE OR DELETE ON recruitment_invitations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_recruitment_invitation_response_links();

DROP TRIGGER IF EXISTS recruitment_invitation_response_audit_links
  ON recruitment_invitation_response_audit;
CREATE CONSTRAINT TRIGGER recruitment_invitation_response_audit_links
  AFTER INSERT OR UPDATE OR DELETE ON recruitment_invitation_response_audit
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_recruitment_invitation_response_links();

DROP TRIGGER IF EXISTS recruitment_invitation_response_outbox_links
  ON recruitment_invitation_response_outbox;
CREATE CONSTRAINT TRIGGER recruitment_invitation_response_outbox_links
  AFTER INSERT OR UPDATE OR DELETE ON recruitment_invitation_response_outbox
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_recruitment_invitation_response_links();

CREATE OR REPLACE FUNCTION prevent_recruitment_invitation_response_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Invitation response audit rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recruitment_invitation_response_audit_immutable
  ON recruitment_invitation_response_audit;
CREATE TRIGGER recruitment_invitation_response_audit_immutable
  BEFORE UPDATE OR DELETE ON recruitment_invitation_response_audit
  FOR EACH ROW
  EXECUTE FUNCTION prevent_recruitment_invitation_response_audit_mutation();

CREATE OR REPLACE FUNCTION preserve_recruitment_invitation_response_outbox_request()
RETURNS trigger AS $$
BEGIN
  IF NEW.effect_id IS DISTINCT FROM OLD.effect_id
    OR NEW.effect_type IS DISTINCT FROM OLD.effect_type
    OR NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
    OR NEW.interview_id IS DISTINCT FROM OLD.interview_id
    OR NEW.schedule_revision IS DISTINCT FROM OLD.schedule_revision
    OR NEW.response_revision IS DISTINCT FROM OLD.response_revision
    OR NEW.response_state IS DISTINCT FROM OLD.response_state
    OR NEW.response_message IS DISTINCT FROM OLD.response_message
    OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
  THEN
    RAISE EXCEPTION 'Invitation response outbox request is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recruitment_invitation_response_outbox_request_immutable
  ON recruitment_invitation_response_outbox;
CREATE TRIGGER recruitment_invitation_response_outbox_request_immutable
  BEFORE UPDATE ON recruitment_invitation_response_outbox
  FOR EACH ROW
  EXECUTE FUNCTION preserve_recruitment_invitation_response_outbox_request();
