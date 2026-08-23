ALTER TABLE admission_applications
  ADD COLUMN IF NOT EXISTS activation_digest text NULL;

UPDATE admission_applications AS application
SET activation_digest = CASE
  WHEN outbox.payload_json ->> 'activationToken' IS NOT NULL
    THEN encode(
      sha256(convert_to(outbox.payload_json ->> 'activationToken', 'UTF8')),
      'hex'
    )
  ELSE outbox.payload_json ->> 'activationDigest'
END
FROM admission_application_outbox AS outbox
WHERE outbox.application_id = application.application_id
  AND outbox.effect_type = 'SendApplicantActivationOrConfirmation'
  AND application.activation_digest IS NULL
  AND (
    outbox.payload_json ->> 'activationToken' IS NOT NULL
    OR (
      outbox.status = 'Delivered'
      AND outbox.payload_json ->> 'activationDigest' ~ '^[a-f0-9]{64}$'
    )
  );

UPDATE admission_application_outbox
SET payload_json = '{}'::jsonb
WHERE status = 'Delivered'
  AND payload_json <> '{}'::jsonb;
