-- Migration 78 moved every undelivered team application notification onto its queue item
-- and made the claim columns unwritable. The queue item owns the lease and the attempt
-- count, so the claim columns and the claim order index go.
DROP INDEX public.team_application_outbox_due;

ALTER TABLE public.team_application_outbox
  DROP CONSTRAINT team_application_outbox_unclaimed,
  DROP CONSTRAINT team_application_outbox_claimed_at_ms,
  DROP CONSTRAINT team_application_outbox_attempts_check,
  DROP COLUMN claim_id,
  DROP COLUMN claimed_at,
  DROP COLUMN attempts;
