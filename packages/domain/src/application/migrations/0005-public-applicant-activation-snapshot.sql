ALTER TABLE admission_applications
  ADD COLUMN IF NOT EXISTS activation_digest text NULL;

ALTER TABLE admission_applications
  DROP CONSTRAINT IF EXISTS admission_applications_activation_digest_sha256;

ALTER TABLE admission_applications
  ADD CONSTRAINT admission_applications_activation_digest_sha256
  CHECK (activation_digest IS NULL OR activation_digest ~ '^[a-f0-9]{64}$');

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
SET status = 'Quarantined',
  claim_id = NULL,
  claimed_at = NULL,
  last_failure_tag = 'LegacyPublicApplicationEffectOrder',
  payload_json = '{}'::jsonb,
  effect_type = CASE ordinal
    WHEN 0 THEN 'SendApplicantActivationOrConfirmation'
    WHEN 1 THEN 'CreateAdmissionSubscription'
    WHEN 2 THEN 'WriteApplicationAudit'
  END
WHERE status <> 'Delivered'
  AND (
    (ordinal = 0 AND effect_type <> 'SendApplicantActivationOrConfirmation')
    OR (ordinal = 1 AND effect_type <> 'CreateAdmissionSubscription')
    OR (ordinal = 2 AND effect_type <> 'WriteApplicationAudit')
  );

UPDATE admission_application_outbox
SET effect_type = CASE ordinal
    WHEN 0 THEN 'SendApplicantActivationOrConfirmation'
    WHEN 1 THEN 'CreateAdmissionSubscription'
    WHEN 2 THEN 'WriteApplicationAudit'
  END,
  payload_json = '{}'::jsonb
WHERE status = 'Delivered'
  AND (
    (ordinal = 0 AND effect_type <> 'SendApplicantActivationOrConfirmation')
    OR (ordinal = 1 AND effect_type <> 'CreateAdmissionSubscription')
    OR (ordinal = 2 AND effect_type <> 'WriteApplicationAudit')
  );

ALTER TABLE admission_application_outbox
  DROP CONSTRAINT IF EXISTS admission_application_outbox_effect_order;

ALTER TABLE admission_application_outbox
  ADD CONSTRAINT admission_application_outbox_effect_order
  CHECK (
    (ordinal = 0 AND effect_type = 'SendApplicantActivationOrConfirmation')
    OR (ordinal = 1 AND effect_type = 'CreateAdmissionSubscription')
    OR (ordinal = 2 AND effect_type = 'WriteApplicationAudit')
  );
