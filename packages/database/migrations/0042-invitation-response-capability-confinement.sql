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
    (
      status IN ('Delivered', 'Quarantined')
      AND payload_json = '{}'::jsonb
    )
    OR (
      status NOT IN ('Delivered', 'Quarantined')
      AND payload_json = jsonb_build_object(
        '_tag', payload_json->'_tag',
        'effectId', payload_json->'effectId',
        'invitationId', payload_json->'invitationId',
        'interviewId', payload_json->'interviewId',
        'scheduleRevision', payload_json->'scheduleRevision',
        'responseRevision', payload_json->'responseRevision',
        'applicantDisplayName', payload_json->'applicantDisplayName',
        'interviewerEmail', payload_json->'interviewerEmail',
        'interviewerPhone', payload_json->'interviewerPhone',
        'scheduledAt', payload_json->'scheduledAt',
        'responseState', payload_json->'responseState',
        'responseMessage', payload_json->'responseMessage'
      )
      AND (payload_json->>'_tag') IS NOT DISTINCT FROM effect_type
      AND (payload_json->>'effectId') IS NOT DISTINCT FROM effect_id
      AND (payload_json->>'invitationId') IS NOT DISTINCT FROM invitation_id
      AND (payload_json->>'interviewId') IS NOT DISTINCT FROM interview_id
      AND (payload_json->'scheduleRevision') = to_jsonb(schedule_revision)
      AND (payload_json->'responseRevision') = to_jsonb(response_revision)
      AND (payload_json->>'responseState') IS NOT DISTINCT FROM response_state
      AND (payload_json->>'responseMessage') IS NOT DISTINCT FROM response_message
    )
  );
