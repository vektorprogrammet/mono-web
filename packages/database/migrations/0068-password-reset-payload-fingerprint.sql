-- Preserve credential-free delivery state. The canonical token stays in auth.verification.
ALTER TABLE auth.password_reset_email_outbox
  ADD COLUMN payload_sha256 text CHECK (payload_sha256 ~ '^[a-f0-9]{64}$');

-- An attempted legacy row has no trustworthy first-payload identity.
UPDATE auth.password_reset_email_outbox
SET status = 'Quarantined', claim_id = NULL, claimed_at = NULL,
    last_failure_code = 'verification-invalid'
WHERE attempts > 0 AND status IN ('Pending', 'Failed', 'Processing');
