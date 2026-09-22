ALTER TABLE auth.password_reset_email_outbox
ADD COLUMN provider_reference text;
