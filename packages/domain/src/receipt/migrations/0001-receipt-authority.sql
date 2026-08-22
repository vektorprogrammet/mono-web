CREATE TABLE IF NOT EXISTS economy_receipts (
  receipt_id text PRIMARY KEY,
  visual_id text NOT NULL UNIQUE,
  owner_person_id text NOT NULL,
  department_id text NOT NULL,
  amount_ore bigint NOT NULL CHECK (amount_ore > 0),
  currency text NOT NULL CHECK (currency = 'NOK'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 5000),
  receipt_date date NOT NULL,
  submitted_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('Pending', 'Refunded', 'Rejected', 'Withdrawn')),
  refund_date timestamptz NULL,
  payment_account_ciphertext text NOT NULL,
  file_ref text NOT NULL,
  file_object_key text NOT NULL,
  file_content_type text NOT NULL CHECK (file_content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  file_byte_length bigint NOT NULL CHECK (file_byte_length > 0),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision >= 0),
  CHECK ((status = 'Refunded' AND refund_date IS NOT NULL) OR (status <> 'Refunded' AND refund_date IS NULL))
);

CREATE TABLE IF NOT EXISTS economy_receipt_command_receipts (
  command_id text PRIMARY KEY,
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  command_json jsonb NOT NULL,
  observation_json jsonb NOT NULL,
  receipt_id text NOT NULL REFERENCES economy_receipts(receipt_id),
  committed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS economy_receipt_outbox (
  effect_id text PRIMARY KEY,
  effect_type text NOT NULL,
  receipt_id text NOT NULL REFERENCES economy_receipts(receipt_id),
  command_id text NOT NULL REFERENCES economy_receipt_command_receipts(command_id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Delivered', 'Failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  UNIQUE (command_id, ordinal)
);
ALTER TABLE economy_receipt_outbox ADD COLUMN IF NOT EXISTS ordinal integer;
WITH ranked AS (
  SELECT effect_id, row_number() OVER (
    PARTITION BY command_id ORDER BY effect_id
  ) - 1 AS inferred_ordinal
  FROM economy_receipt_outbox
  WHERE ordinal IS NULL
)
UPDATE economy_receipt_outbox AS target
SET ordinal = ranked.inferred_ordinal
FROM ranked
WHERE target.effect_id = ranked.effect_id;
ALTER TABLE economy_receipt_outbox ALTER COLUMN ordinal SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS economy_receipt_outbox_command_ordinal
  ON economy_receipt_outbox (command_id, ordinal);
CREATE INDEX IF NOT EXISTS economy_receipt_outbox_pending_order
  ON economy_receipt_outbox (status, command_id, ordinal);


CREATE TABLE IF NOT EXISTS economy_receipt_audit (
  command_id text PRIMARY KEY REFERENCES economy_receipt_command_receipts(command_id),
  receipt_id text NOT NULL REFERENCES economy_receipts(receipt_id),
  actor_person_id text NOT NULL,
  action text NOT NULL,
  receipt_revision integer NOT NULL CHECK (receipt_revision >= 0),
  occurred_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS economy_receipt_import_ledger (
  source_repository text NOT NULL,
  source_revision text NOT NULL,
  snapshot_id text NOT NULL,
  source_watermark text NOT NULL,
  source_primary_key text NOT NULL,
  source_digest text NOT NULL,
  transformation_revision text NOT NULL,
  target_semantic_identity text NOT NULL,
  destination_identity text NULL,
  result text NOT NULL CHECK (result IN ('Accepted', 'Quarantined')),
  reconciliation_result text NOT NULL,
  reasons_json jsonb NOT NULL,
  PRIMARY KEY (source_repository, source_revision, snapshot_id, source_primary_key, transformation_revision)
);
