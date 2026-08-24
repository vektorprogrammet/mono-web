CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS economy_payment_authorities (
  payment_authority_id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES person_profiles(person_id) ON DELETE RESTRICT,
  department_id text NOT NULL
    REFERENCES organization_departments(department_id) ON DELETE RESTRICT,
  payment_account_ciphertext text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT economy_payment_authorities_id_nonempty CHECK (
    btrim(payment_authority_id) <> ''
  ),
  CONSTRAINT economy_payment_authorities_ciphertext_nonempty CHECK (
    btrim(payment_account_ciphertext) <> ''
  ),
  CONSTRAINT economy_payment_authorities_interval_ordered CHECK (
    end_at IS NULL OR end_at > start_at
  ),
  CONSTRAINT economy_payment_authorities_revision_nonnegative CHECK (
    revision >= 0
  ),
  CONSTRAINT economy_payment_authorities_no_overlap
    EXCLUDE USING gist (
      person_id WITH =,
      department_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
);

CREATE TABLE IF NOT EXISTS economy_receipt_approval_grants (
  approval_grant_id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES person_profiles(person_id) ON DELETE RESTRICT,
  scope text NOT NULL,
  department_id text NULL
    REFERENCES organization_departments(department_id) ON DELETE RESTRICT,
  start_at timestamptz NOT NULL,
  end_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT economy_receipt_approval_grants_id_nonempty CHECK (
    btrim(approval_grant_id) <> ''
  ),
  CONSTRAINT economy_receipt_approval_grants_scope CHECK (
    scope IN ('Department', 'Global')
  ),
  CONSTRAINT economy_receipt_approval_grants_scope_department CHECK (
    (scope = 'Department' AND department_id IS NOT NULL)
    OR (scope = 'Global' AND department_id IS NULL)
  ),
  CONSTRAINT economy_receipt_approval_grants_interval_ordered CHECK (
    end_at IS NULL OR end_at > start_at
  ),
  CONSTRAINT economy_receipt_approval_grants_revision_nonnegative CHECK (
    revision >= 0
  ),
  CONSTRAINT economy_receipt_department_approval_grants_no_overlap
    EXCLUDE USING gist (
      person_id WITH =,
      department_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
    WHERE (scope = 'Department'),
  CONSTRAINT economy_receipt_global_approval_grants_no_overlap
    EXCLUDE USING gist (
      person_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    )
    WHERE (scope = 'Global')
);

CREATE INDEX IF NOT EXISTS economy_payment_authorities_person_order
  ON economy_payment_authorities (
    person_id,
    department_id,
    start_at,
    payment_authority_id
  );
CREATE INDEX IF NOT EXISTS economy_receipt_approval_grants_person_order
  ON economy_receipt_approval_grants (
    person_id,
    scope,
    department_id,
    start_at,
    approval_grant_id
  );
