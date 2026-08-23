ALTER TABLE admission_applications
  ADD COLUMN IF NOT EXISTS activation_digest text NULL;

UPDATE admission_applications AS application
SET activation_digest = encode(
  sha256(convert_to(outbox.payload_json ->> 'activationToken', 'UTF8')),
  'hex'
)
FROM admission_application_outbox AS outbox
WHERE outbox.application_id = application.application_id
  AND outbox.effect_type = 'SendApplicantActivationOrConfirmation'
  AND outbox.payload_json ->> 'activationToken' IS NOT NULL
  AND application.activation_digest IS NULL;

UPDATE admission_application_outbox
SET payload_json = '{}'::jsonb
WHERE status = 'Delivered'
  AND payload_json <> '{}'::jsonb;
