ALTER TABLE admission_application_outbox
  DROP CONSTRAINT IF EXISTS admission_application_outbox_status_check;

ALTER TABLE admission_application_outbox
  ADD CONSTRAINT admission_application_outbox_status_check
  CHECK (status IN ('Pending', 'Processing', 'Delivered', 'Failed', 'Quarantined'));

WITH incompatible_commands AS (
  SELECT DISTINCT command_id
  FROM admission_application_outbox
  WHERE status IN ('Pending', 'Processing', 'Failed')
    AND (
      (
        effect_type = 'SendApplicantActivationOrConfirmation'
        AND payload_json ->> 'activationDigest' IS NOT NULL
      )
      OR (
        effect_type = 'CreateAdmissionSubscription'
        AND NULLIF(payload_json ->> 'departmentId', '') IS NULL
      )
    )
)
UPDATE admission_application_outbox AS outbox
SET status = 'Quarantined',
  claim_id = NULL,
  claimed_at = NULL,
  last_failure_tag = 'LegacyPublicApplicationEffectPayload',
  payload_json = '{}'::jsonb
FROM incompatible_commands
WHERE outbox.command_id = incompatible_commands.command_id
  AND outbox.status IN ('Pending', 'Processing', 'Failed');

UPDATE admission_application_outbox
SET payload_json = '{}'::jsonb
WHERE status = 'Delivered'
  AND payload_json <> '{}'::jsonb;
