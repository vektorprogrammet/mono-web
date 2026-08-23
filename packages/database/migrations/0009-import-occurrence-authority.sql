ALTER TABLE economy_receipt_import_ledger
  ADD COLUMN IF NOT EXISTS source_occurrence integer;
UPDATE economy_receipt_import_ledger
SET source_occurrence = 0
WHERE source_occurrence IS NULL;
ALTER TABLE economy_receipt_import_ledger
  ALTER COLUMN source_occurrence SET NOT NULL;
ALTER TABLE economy_receipt_import_ledger
  DROP CONSTRAINT IF EXISTS economy_receipt_import_ledger_pkey;
ALTER TABLE economy_receipt_import_ledger
  ADD CONSTRAINT economy_receipt_import_ledger_pkey PRIMARY KEY (
    source_repository,
    source_revision,
    snapshot_id,
    source_primary_key,
    source_occurrence,
    transformation_revision
  );

ALTER TABLE organization_membership_quarantine
  ADD COLUMN IF NOT EXISTS source_occurrence integer;
UPDATE organization_membership_quarantine
SET source_occurrence = 0
WHERE source_occurrence IS NULL;
ALTER TABLE organization_membership_quarantine
  ALTER COLUMN source_occurrence SET NOT NULL;
ALTER TABLE organization_membership_quarantine
  DROP CONSTRAINT IF EXISTS organization_membership_quarantine_pkey;
ALTER TABLE organization_membership_quarantine
  ADD CONSTRAINT organization_membership_quarantine_pkey PRIMARY KEY (
    source_repository,
    source_revision,
    snapshot_id,
    source_kind,
    source_primary_key,
    source_occurrence,
    transformation_revision
  );

ALTER TABLE organization_import_ledger
  ADD COLUMN IF NOT EXISTS source_occurrence integer;
UPDATE organization_import_ledger
SET source_occurrence = 0
WHERE source_occurrence IS NULL;
ALTER TABLE organization_import_ledger
  ALTER COLUMN source_occurrence SET NOT NULL;
ALTER TABLE organization_import_ledger
  DROP CONSTRAINT IF EXISTS organization_import_ledger_pkey;
ALTER TABLE organization_import_ledger
  ADD CONSTRAINT organization_import_ledger_pkey PRIMARY KEY (
    source_repository,
    source_revision,
    snapshot_id,
    source_kind,
    source_primary_key,
    source_occurrence,
    transformation_revision
  );
