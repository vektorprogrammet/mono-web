-- A claimed Receipt effect whose envelope does not decode, or names another effect or command,
-- becomes Quarantined. It is terminal: it is never claimed or delivered again, and later effects
-- of the same receipt stay behind it.
ALTER TABLE public.economy_receipt_outbox
  DROP CONSTRAINT economy_receipt_outbox_status_check;

ALTER TABLE public.economy_receipt_outbox
  ADD CONSTRAINT economy_receipt_outbox_status_check
  CHECK (status IN ('Pending', 'Processing', 'Delivered', 'Failed', 'Quarantined'));
