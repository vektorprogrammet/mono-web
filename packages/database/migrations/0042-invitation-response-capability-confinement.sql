DROP TABLE IF EXISTS public.recruitment_invitation_response_command_receipts;

ALTER TABLE recruitment_invitations
  DROP CONSTRAINT IF EXISTS recruitment_invitations_response_message;

ALTER TABLE recruitment_invitations
  ADD CONSTRAINT recruitment_invitations_response_message CHECK (
    response_message IS NULL OR (
      response_message = btrim(response_message)
      AND response_message <> ''
      AND char_length(response_message) <= 2000
      AND response_message !~ '[A-Za-z0-9_-]{43}'
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
    (payload_json - 'effectId' - 'invitationId' - 'interviewId')::text
      !~ '[A-Za-z0-9_-]{43}'
  );
