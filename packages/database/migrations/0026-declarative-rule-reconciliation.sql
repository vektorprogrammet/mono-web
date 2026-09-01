-- Compile the frozen spec 0056.2 rule variants. Unsupported persisted rows
-- abort before this migration mutates the table.
DO $migration$
DECLARE
  unsupported_rows text;
BEGIN
  WITH classified AS (
    SELECT
      rule.rule_id,
      CASE
        WHEN (
          (rule.subject_kind = 'Person' AND rule.subject_person_id IS NOT NULL AND rule.subject_tag_id IS NULL)
          OR (rule.subject_kind = 'Tag' AND rule.subject_person_id IS NULL AND rule.subject_tag_id IS NOT NULL)
        ) IS NOT TRUE THEN 'SUBJECT_COLUMNS_INVALID'
        WHEN (
          (rule.subject_kind = 'Person' AND EXISTS (
            SELECT 1
            FROM public.person_profiles AS person
            WHERE person.person_id = rule.subject_person_id
          ))
          OR (rule.subject_kind = 'Tag' AND EXISTS (
            SELECT 1
            FROM public.authz_tags AS tag
            WHERE tag.tag_id = rule.subject_tag_id
          ))
        ) IS NOT TRUE THEN 'SUBJECT_REFERENCE_MISSING'
        WHEN (
          (rule.scope = 'Global' AND rule.domain_id IS NULL AND rule.department_id IS NULL)
          OR (
            rule.scope = 'Domain'
            AND rule.domain_id = 'receipts'
            AND rule.department_id IS NULL
          )
          OR (
            rule.scope = 'Department'
            AND rule.domain_id IS NULL
            AND rule.department_id IS NOT NULL
          )
        ) IS NOT TRUE THEN 'SCOPE_COLUMNS_INVALID'
        WHEN (
          rule.scope <> 'Department'
          OR EXISTS (
            SELECT 1
            FROM public.organization_departments AS department
            WHERE department.department_id = rule.department_id
          )
        ) IS NOT TRUE THEN 'SCOPE_REFERENCE_MISSING'
        WHEN (rule.end_at IS NULL OR rule.end_at > rule.start_at) IS NOT TRUE
          THEN 'INTERVAL_INVALID'
        WHEN (rule.revision >= 0) IS NOT TRUE THEN 'REVISION_INVALID'
        WHEN (
          (
            rule.capability_id = 'approveReceipt'
            AND rule.effect_kind = 'delegate'
            AND rule.params IN (
              '{"slot":"EconomyDepartmentApprovalGrant"}'::jsonb,
              '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb
            )
          )
          OR (
            rule.capability_id = 'submitReceipt'
            AND rule.effect_kind = 'delegate'
            AND jsonb_typeof(rule.params) = 'object'
            AND rule.params = jsonb_build_object(
              'slot', 'EconomyPaymentAuthority',
              'paymentAccountCiphertext', rule.params -> 'paymentAccountCiphertext'
            )
            AND rule.params ->> 'slot' = 'EconomyPaymentAuthority'
            AND jsonb_typeof(rule.params -> 'paymentAccountCiphertext') = 'string'
            AND public.authz_is_ecmascript_trimmed_nonempty(
              rule.params ->> 'paymentAccountCiphertext'
            )
          )
          OR (
            rule.capability_id = 'approveReceipt'
            AND rule.effect_kind = 'requirement'
            AND jsonb_typeof(rule.params) = 'object'
            AND rule.params = jsonb_build_object(
              'requirementId', rule.params -> 'requirementId',
              'parameters', '{}'::jsonb
            )
            AND rule.params ->> 'requirementId' IN (
              'receipts.pending',
              'receipts.approver-relationship'
            )
            AND rule.params -> 'parameters' = '{}'::jsonb
          )
        ) IS NOT TRUE THEN 'VARIANT_INVALID'
        ELSE NULL
      END AS reason_code
    FROM public.authz_rules AS rule
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'ruleId', classified.rule_id,
      'reasonCode', classified.reason_code
    )
    ORDER BY classified.rule_id
  )::text
  INTO unsupported_rows
  FROM classified
  WHERE classified.reason_code IS NOT NULL;

  IF unsupported_rows IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'authz_rules preflight failed: ' || unsupported_rows;
  END IF;
END
$migration$;

ALTER TABLE public.authz_rules
  DROP CONSTRAINT authz_rules_params_declared;

ALTER TABLE public.authz_rules
  ADD CONSTRAINT authz_rules_params_declared CHECK (
    (
      capability_id = 'approveReceipt'
      AND effect_kind = 'delegate'
      AND params IN (
        '{"slot":"EconomyDepartmentApprovalGrant"}'::jsonb,
        '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb
      )
    )
    OR (
      capability_id = 'submitReceipt'
      AND effect_kind = 'delegate'
      AND jsonb_typeof(params) = 'object'
      AND params = jsonb_build_object(
        'slot', 'EconomyPaymentAuthority',
        'paymentAccountCiphertext', params -> 'paymentAccountCiphertext'
      )
      AND params ->> 'slot' = 'EconomyPaymentAuthority'
      AND jsonb_typeof(params -> 'paymentAccountCiphertext') = 'string'
      AND public.authz_is_ecmascript_trimmed_nonempty(
        params ->> 'paymentAccountCiphertext'
      )
    )
    OR (
      capability_id = 'approveReceipt'
      AND effect_kind = 'requirement'
      AND jsonb_typeof(params) = 'object'
      AND params = jsonb_build_object(
        'requirementId', params -> 'requirementId',
        'parameters', '{}'::jsonb
      )
      AND params ->> 'requirementId' IN (
        'receipts.pending',
        'receipts.approver-relationship'
      )
      AND params -> 'parameters' = '{}'::jsonb
    )
  );
