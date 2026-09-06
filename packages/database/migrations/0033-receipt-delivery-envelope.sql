ALTER TABLE public.economy_receipt_outbox ADD COLUMN delivery_envelope jsonb;
ALTER TABLE public.economy_receipt_outbox ADD CONSTRAINT receipt_delivery_envelope_shape CHECK (
  delivery_envelope IS NULL OR (
    effect_type IN ('NotifyEconomyReceiptSubmitted','NotifyReceiptRefunded','NotifyReceiptRejected')
    AND jsonb_typeof(delivery_envelope) = 'object'
    AND delivery_envelope ->> 'deliveryId' = effect_id
    AND delivery_envelope ?& ARRAY['deliveryId','from','to','subject','text']
  )
);
CREATE FUNCTION public.freeze_receipt_delivery_envelope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.delivery_envelope IS NOT NULL AND NEW.delivery_envelope IS DISTINCT FROM OLD.delivery_envelope THEN
    RAISE EXCEPTION 'Receipt delivery envelope is immutable';
  END IF;
  IF OLD.delivery_envelope IS NULL AND NEW.delivery_envelope IS NOT NULL
    AND (OLD.status <> 'Processing' OR NEW.claim_id IS DISTINCT FROM OLD.claim_id) THEN
    RAISE EXCEPTION 'Receipt delivery envelope requires active claim';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER receipt_delivery_envelope_immutable BEFORE UPDATE ON public.economy_receipt_outbox
FOR EACH ROW EXECUTE FUNCTION public.freeze_receipt_delivery_envelope();
