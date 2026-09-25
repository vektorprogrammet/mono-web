-- Upgraded databases miss CHECK constraints that fresh databases get from 0001 and 0008.
-- Those files declare the import occurrence checks only inside CREATE TABLE IF NOT EXISTS,
-- and 0009 added source_occurrence to existing tables without them. A database that replayed
-- 0001 as migration 4 before 0001 bounded file_byte_length keeps the unbounded check.
-- Recreating the constraints gives every database the fresh definitions; a fresh database
-- keeps the same definitions.
ALTER TABLE public.economy_receipt_import_ledger
  DROP CONSTRAINT IF EXISTS economy_receipt_import_ledger_source_occurrence_check;

ALTER TABLE public.economy_receipt_import_ledger
  ADD CONSTRAINT economy_receipt_import_ledger_source_occurrence_check
  CHECK (source_occurrence >= 0);

ALTER TABLE public.organization_import_ledger
  DROP CONSTRAINT IF EXISTS organization_import_ledger_source_occurrence_check;

ALTER TABLE public.organization_import_ledger
  ADD CONSTRAINT organization_import_ledger_source_occurrence_check
  CHECK (source_occurrence >= 0);

ALTER TABLE public.organization_membership_quarantine
  DROP CONSTRAINT IF EXISTS organization_membership_quarantine_source_occurrence_check;

ALTER TABLE public.organization_membership_quarantine
  ADD CONSTRAINT organization_membership_quarantine_source_occurrence_check
  CHECK (source_occurrence >= 0);

ALTER TABLE public.economy_receipts
  DROP CONSTRAINT IF EXISTS economy_receipts_file_byte_length_check;

ALTER TABLE public.economy_receipts
  ADD CONSTRAINT economy_receipts_file_byte_length_check
  CHECK (file_byte_length > 0 AND file_byte_length <= 9007199254740991);
