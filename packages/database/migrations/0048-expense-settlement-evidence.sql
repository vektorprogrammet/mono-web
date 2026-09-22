CREATE EXTENSION IF NOT EXISTS btree_gist;

-- The former decision name is a native schema change, not evidence of payment.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.economy_receipts'::regclass
      AND pg_get_constraintdef(oid) LIKE '%Refunded%'
  LOOP
    EXECUTE format('ALTER TABLE public.economy_receipts DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.economy_receipts RENAME COLUMN refund_date TO approved_at;
UPDATE public.economy_receipts
SET status = 'Approved'
WHERE status = 'Refunded';

ALTER TABLE public.economy_receipts
  ADD CONSTRAINT economy_receipts_status_check
  CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Withdrawn'));
ALTER TABLE public.economy_receipts
  ADD CONSTRAINT economy_receipts_approved_at_check
  CHECK (
    (status = 'Approved' AND approved_at IS NOT NULL)
    OR (status <> 'Approved' AND approved_at IS NULL)
  );

-- Stored observations are decoded on command replay, so they must match the
-- active status schema. command_json and command_sha256 retain the original
-- authenticated request as historical evidence; the adapter has an internal
-- historical decoder for that retired request variant.
UPDATE public.economy_receipt_command_receipts
SET observation_json = jsonb_set(observation_json, '{status}', '"Approved"'::jsonb, true)
WHERE observation_json ->> 'status' = 'Refunded';
UPDATE public.economy_receipt_audit
SET action = 'ReceiptApproved'
WHERE action = 'ReceiptRefunded';

ALTER TABLE public.economy_receipt_outbox
  DROP CONSTRAINT IF EXISTS receipt_delivery_envelope_shape;
ALTER TABLE public.economy_receipt_outbox
  DISABLE TRIGGER receipt_delivery_envelope_immutable;
UPDATE public.economy_receipt_outbox
SET
  effect_type = 'NotifyReceiptApproved',
  payload_json = jsonb_set(payload_json, '{_tag}', '"NotifyReceiptApproved"'::jsonb, true),
  delivery_envelope = CASE
    WHEN delivery_envelope IS NULL THEN NULL
    ELSE jsonb_set(
      jsonb_set(
        delivery_envelope,
        '{subject}',
        to_jsonb('Utlegget ditt er godkjent'::text),
        true
      ),
      '{text}',
      to_jsonb(replace(delivery_envelope ->> 'text', 'markert som refundert', 'godkjent')),
      true
    )
  END
WHERE effect_type = 'NotifyReceiptRefunded';
ALTER TABLE public.economy_receipt_outbox
  ENABLE TRIGGER receipt_delivery_envelope_immutable;
ALTER TABLE public.economy_receipt_outbox
  ADD CONSTRAINT receipt_delivery_envelope_shape CHECK (
    delivery_envelope IS NULL OR (
      effect_type IN (
        'NotifyEconomyReceiptSubmitted',
        'NotifyReceiptApproved',
        'NotifyReceiptRejected',
        'NotifyReceiptSettled'
      )
      AND jsonb_typeof(delivery_envelope) = 'object'
      AND delivery_envelope ->> 'deliveryId' = effect_id
      AND delivery_envelope ?& ARRAY['deliveryId','from','to','subject','text']
    )
  );

CREATE TABLE public.economy_receipt_settlement_grants (
  settlement_grant_id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES public.person_profiles(person_id) ON DELETE RESTRICT,
  scope text NOT NULL,
  department_id text NULL
    REFERENCES public.organization_departments(department_id) ON DELETE RESTRICT,
  start_at timestamptz NOT NULL,
  end_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT economy_receipt_settlement_grants_id_nonempty CHECK (
    btrim(settlement_grant_id) <> ''
  ),
  CONSTRAINT economy_receipt_settlement_grants_scope CHECK (
    scope IN ('Department', 'Global')
  ),
  CONSTRAINT economy_receipt_settlement_grants_scope_department CHECK (
    (scope = 'Department' AND department_id IS NOT NULL)
    OR (scope = 'Global' AND department_id IS NULL)
  ),
  CONSTRAINT economy_receipt_settlement_grants_interval_ordered CHECK (
    end_at IS NULL OR end_at > start_at
  ),
  CONSTRAINT economy_receipt_settlement_grants_revision_nonnegative CHECK (
    revision >= 0
  ),
  CONSTRAINT economy_receipt_department_settlement_grants_no_overlap
    EXCLUDE USING gist (
      person_id WITH =,
      department_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
    WHERE (scope = 'Department'),
  CONSTRAINT economy_receipt_global_settlement_grants_no_overlap
    EXCLUDE USING gist (
      person_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
    WHERE (scope = 'Global')
);
CREATE INDEX economy_receipt_settlement_grants_person_order
  ON public.economy_receipt_settlement_grants (
    person_id,
    scope,
    department_id,
    start_at,
    settlement_grant_id
  );

CREATE TABLE public.economy_receipt_settlements (
  settlement_id text PRIMARY KEY,
  receipt_id text NOT NULL UNIQUE
    REFERENCES public.economy_receipts(receipt_id) ON DELETE RESTRICT,
  amount_ore bigint NOT NULL CHECK (
    amount_ore > 0 AND amount_ore <= 9007199254740991
  ),
  currency text NOT NULL CHECK (currency = 'NOK'),
  payment_destination_fingerprint text NOT NULL CHECK (
    payment_destination_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  external_authority text NOT NULL CHECK (
    btrim(external_authority) <> '' AND btrim(external_authority) = external_authority
  ),
  external_reference text NOT NULL CHECK (
    btrim(external_reference) <> '' AND btrim(external_reference) = external_reference
  ),
  settled_at timestamptz NOT NULL,
  recorded_by_person_id text NOT NULL
    REFERENCES public.person_profiles(person_id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL,
  receipt_revision integer NOT NULL CHECK (receipt_revision >= 0),
  CONSTRAINT economy_receipt_settlements_id_nonempty CHECK (btrim(settlement_id) <> ''),
  CONSTRAINT economy_receipt_settlements_recorded_after_settled CHECK (
    settled_at <= recorded_at
  ),
  CONSTRAINT economy_receipt_settlements_external_reference_unique
    UNIQUE (external_authority, external_reference)
);

CREATE FUNCTION public.freeze_economy_receipt_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Receipt settlement evidence is immutable';
  RETURN NULL;
END;
$$;
CREATE TRIGGER economy_receipt_settlements_immutable
  BEFORE UPDATE OR DELETE ON public.economy_receipt_settlements
  FOR EACH ROW EXECUTE FUNCTION public.freeze_economy_receipt_settlement();
