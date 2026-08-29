CREATE TABLE IF NOT EXISTS public.authz_tags (
  tag_id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT authz_tags_id_nonempty CHECK (
    btrim(tag_id) <> '' AND btrim(tag_id) = tag_id
  ),
  CONSTRAINT authz_tags_name_nonempty CHECK (
    btrim(name) <> '' AND btrim(name) = name
  ),
  CONSTRAINT authz_tags_revision_nonnegative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS public.authz_tag_assignments (
  assignment_id text PRIMARY KEY,
  tag_id text NOT NULL
    REFERENCES public.authz_tags(tag_id) ON DELETE RESTRICT,
  person_id text NOT NULL
    REFERENCES public.person_profiles(person_id) ON DELETE RESTRICT,
  start_at timestamptz NOT NULL,
  end_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT authz_tag_assignments_id_nonempty CHECK (
    btrim(assignment_id) <> '' AND btrim(assignment_id) = assignment_id
  ),
  CONSTRAINT authz_tag_assignments_interval_ordered CHECK (
    end_at IS NULL OR end_at > start_at
  ),
  CONSTRAINT authz_tag_assignments_revision_nonnegative CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS public.authz_rules (
  rule_id text PRIMARY KEY,
  capability_id text NOT NULL,
  effect_kind text NOT NULL,
  subject_kind text NOT NULL,
  subject_person_id text NULL
    REFERENCES public.person_profiles(person_id) ON DELETE RESTRICT,
  subject_tag_id text NULL
    REFERENCES public.authz_tags(tag_id) ON DELETE RESTRICT,
  scope text NOT NULL,
  department_id text NULL
    REFERENCES public.organization_departments(department_id) ON DELETE RESTRICT,
  params jsonb NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NULL,
  revision integer NOT NULL DEFAULT 0,
  CONSTRAINT authz_rules_id_nonempty CHECK (
    btrim(rule_id) <> '' AND btrim(rule_id) = rule_id
  ),
  CONSTRAINT authz_rules_capability_declared CHECK (
    capability_id IN ('approveReceipt', 'submitReceipt', 'reviewApplicants')
  ),
  CONSTRAINT authz_rules_effect_kind_declared CHECK (
    effect_kind IN ('delegate', 'parameter', 'requirement')
  ),
  CONSTRAINT authz_rules_subject_declared CHECK (
    (subject_kind = 'Person' AND subject_person_id IS NOT NULL AND subject_tag_id IS NULL)
    OR (subject_kind = 'Tag' AND subject_person_id IS NULL AND subject_tag_id IS NOT NULL)
  ),
  CONSTRAINT authz_rules_scope_declared CHECK (
    (scope = 'Department' AND department_id IS NOT NULL)
    OR (scope IN ('Global', 'Receipt') AND department_id IS NULL)
  ),
  CONSTRAINT authz_rules_params_declared CHECK (
    CASE
      WHEN capability_id = 'approveReceipt' AND effect_kind = 'delegate' THEN
        COALESCE(
          params = '{"slot":"EconomyDepartmentApprovalGrant"}'::jsonb
          OR params = '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
          FALSE
        )
      WHEN capability_id = 'submitReceipt' AND effect_kind = 'delegate' THEN
        COALESCE(
          jsonb_typeof(params) = 'object'
          AND params ? 'slot'
          AND params ? 'paymentAccountCiphertext'
          AND (params - 'slot' - 'paymentAccountCiphertext') = '{}'::jsonb
          AND jsonb_typeof(params -> 'slot') = 'string'
          AND params ->> 'slot' = 'EconomyPaymentAuthority'
          AND jsonb_typeof(params -> 'paymentAccountCiphertext') = 'string'
          AND params ->> 'paymentAccountCiphertext' <> ''
          AND btrim(
            params ->> 'paymentAccountCiphertext',
            chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32)
              || chr(160) || chr(5760)
              || chr(8192) || chr(8193) || chr(8194) || chr(8195)
              || chr(8196) || chr(8197) || chr(8198) || chr(8199)
              || chr(8200) || chr(8201) || chr(8202)
              || chr(8232) || chr(8233) || chr(8239) || chr(8287)
              || chr(12288) || chr(65279)
          ) = params ->> 'paymentAccountCiphertext',
          FALSE
        )
      ELSE FALSE
    END
  ),
  CONSTRAINT authz_rules_interval_ordered CHECK (
    end_at IS NULL OR end_at > start_at
  ),
  CONSTRAINT authz_rules_revision_nonnegative CHECK (revision >= 0)
);

CREATE INDEX IF NOT EXISTS authz_tag_assignments_person_lock_order
  ON public.authz_tag_assignments (person_id, tag_id, assignment_id);

CREATE INDEX IF NOT EXISTS authz_rules_person_lock_order
  ON public.authz_rules (
    capability_id,
    subject_kind,
    subject_person_id,
    start_at,
    rule_id
  );

CREATE INDEX IF NOT EXISTS authz_rules_tag_lock_order
  ON public.authz_rules (
    capability_id,
    subject_kind,
    subject_tag_id,
    start_at,
    rule_id
  );
