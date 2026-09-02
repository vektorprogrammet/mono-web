-- Migration 0028: exact resource-bound service-principal grants (spec 0056.3).

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
          (rule.scope = 'Global' AND rule.domain_id IS NULL AND rule.department_id IS NULL)
          OR (rule.scope = 'Domain' AND rule.domain_id = 'receipts' AND rule.department_id IS NULL)
          OR (rule.scope = 'Department' AND rule.domain_id IS NULL AND rule.department_id IS NOT NULL)
        ) IS NOT TRUE THEN 'SCOPE_COLUMNS_INVALID'
        ELSE NULL
      END AS reason_code
    FROM public.authz_rules AS rule
  )
  SELECT jsonb_agg(
    jsonb_build_object('ruleId', classified.rule_id, 'reasonCode', classified.reason_code)
    ORDER BY classified.rule_id
  )::text
  INTO unsupported_rows
  FROM classified
  WHERE classified.reason_code IS NOT NULL;

  IF unsupported_rows IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'authz_rules 0028 preflight failed: ' || unsupported_rows;
  END IF;
END
$migration$;

ALTER TABLE auth.oauth_client_bindings
  ADD CONSTRAINT oauth_client_bindings_client_service_unique
  UNIQUE (client_id, service_principal_id);

CREATE TABLE public.service_principal_grants (
  grant_id text PRIMARY KEY,
  service_principal_id text NOT NULL,
  client_id text NOT NULL,
  protected_resource text NOT NULL,
  operation_id text NOT NULL,
  capability_id text NOT NULL,
  resource_kind text NOT NULL,
  resource_id text NOT NULL REFERENCES public.economy_receipts (receipt_id) ON DELETE RESTRICT,
  start_at timestamptz NOT NULL,
  end_at timestamptz,
  revoked_at timestamptz,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT service_principal_grants_id_nonempty CHECK (
    public.authz_is_ecmascript_trimmed_nonempty(grant_id)
  ),
  CONSTRAINT service_principal_grants_identity_binding FOREIGN KEY (client_id, service_principal_id)
    REFERENCES auth.oauth_client_bindings (client_id, service_principal_id) ON DELETE RESTRICT,
  CONSTRAINT service_principal_grants_resource_binding FOREIGN KEY (client_id, protected_resource)
    REFERENCES auth."oauthClientResource" ("clientId", "resourceId") ON DELETE RESTRICT,
  CONSTRAINT service_principal_grants_resource_exact CHECK (
    protected_resource = 'urn:vektorprogrammet:native-api'
  ),
  CONSTRAINT service_principal_grants_operation_exact CHECK (
    operation_id = 'receipts.listReceiptsForApproval'
  ),
  CONSTRAINT service_principal_grants_capability_exact CHECK (capability_id = 'approveReceipt'),
  CONSTRAINT service_principal_grants_kind_exact CHECK (resource_kind = 'receipt'),
  CONSTRAINT service_principal_grants_resource_id_nonempty CHECK (
    public.authz_is_ecmascript_trimmed_nonempty(resource_id)
  ),
  CONSTRAINT service_principal_grants_interval_ordered CHECK (end_at IS NULL OR end_at > start_at),
  CONSTRAINT service_principal_grants_revocation_ordered CHECK (
    revoked_at IS NULL OR revoked_at >= start_at
  ),
  CONSTRAINT service_principal_grants_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT service_principal_grants_update_ordered CHECK (updated_at >= created_at),
  CONSTRAINT service_principal_grants_audit_identity_unique UNIQUE (
    grant_id,
    service_principal_id,
    client_id,
    protected_resource,
    operation_id,
    capability_id,
    resource_id
  )
);

CREATE INDEX service_principal_grants_lock_order
  ON public.service_principal_grants (
    service_principal_id,
    client_id,
    protected_resource,
    operation_id,
    resource_kind,
    resource_id,
    start_at,
    grant_id
  );

ALTER TABLE public.authz_rules
  ADD COLUMN subject_service_principal_id text
    REFERENCES public.service_principals (service_principal_id) ON DELETE RESTRICT,
  ADD COLUMN resource_kind text,
  ADD COLUMN resource_id text
    REFERENCES public.economy_receipts (receipt_id) ON DELETE RESTRICT;

ALTER TABLE public.authz_rules
  DROP CONSTRAINT authz_rules_subject_declared,
  DROP CONSTRAINT authz_rules_scope_declared,
  DROP CONSTRAINT authz_rules_params_declared;

ALTER TABLE public.authz_rules
  ADD CONSTRAINT authz_rules_subject_declared CHECK (
    (
      subject_kind = 'Person'
      AND subject_person_id IS NOT NULL
      AND subject_tag_id IS NULL
      AND subject_service_principal_id IS NULL
    )
    OR (
      subject_kind = 'Tag'
      AND subject_person_id IS NULL
      AND subject_tag_id IS NOT NULL
      AND subject_service_principal_id IS NULL
    )
    OR (
      subject_kind = 'ServicePrincipal'
      AND subject_person_id IS NULL
      AND subject_tag_id IS NULL
      AND subject_service_principal_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT authz_rules_scope_declared CHECK (
    (
      scope = 'Global'
      AND domain_id IS NULL
      AND department_id IS NULL
      AND resource_kind IS NULL
      AND resource_id IS NULL
    )
    OR (
      scope = 'Domain'
      AND domain_id = 'receipts'
      AND department_id IS NULL
      AND resource_kind IS NULL
      AND resource_id IS NULL
    )
    OR (
      scope = 'Department'
      AND domain_id IS NULL
      AND department_id IS NOT NULL
      AND resource_kind IS NULL
      AND resource_id IS NULL
    )
    OR (
      scope = 'Resource'
      AND subject_kind = 'ServicePrincipal'
      AND domain_id IS NULL
      AND department_id IS NULL
      AND resource_kind = 'receipt'
      AND public.authz_is_ecmascript_trimmed_nonempty(resource_id)
    )
  ),
  ADD CONSTRAINT authz_rules_params_declared CHECK (
    CASE
      WHEN subject_kind = 'ServicePrincipal' THEN
        capability_id = 'approveReceipt'
        AND effect_kind = 'requirement'
        AND scope = 'Resource'
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
      ELSE
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
          AND public.authz_is_ecmascript_trimmed_nonempty(params ->> 'paymentAccountCiphertext')
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
    END
  );

CREATE INDEX authz_rules_service_principal_lock_order
  ON public.authz_rules (
    capability_id,
    subject_kind,
    subject_service_principal_id,
    resource_kind,
    resource_id,
    start_at,
    rule_id
  );

CREATE TABLE public.service_principal_grant_audit (
  event_id text PRIMARY KEY,
  CONSTRAINT service_principal_grant_audit_event_id_bounded CHECK (
    public.authz_is_ecmascript_trimmed_nonempty(event_id)
    AND char_length(event_id) <= 160
  ),
  occurred_at timestamptz NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN (
    'service-principal-grant-created',
    'service-principal-grant-ended',
    'service-principal-grant-revoked'
  )),
  grant_id text NOT NULL,
  service_principal_id text NOT NULL,
  client_id text NOT NULL,
  protected_resource text NOT NULL CHECK (
    protected_resource = 'urn:vektorprogrammet:native-api'
  ),
  operation_id text NOT NULL CHECK (operation_id = 'receipts.listReceiptsForApproval'),
  capability_id text NOT NULL CHECK (capability_id = 'approveReceipt'),
  resource_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  operator_actor text NOT NULL,
  request_correlation text NOT NULL,
  CONSTRAINT service_principal_grant_audit_operator_actor_bounded CHECK (
    public.authz_is_ecmascript_trimmed_nonempty(operator_actor)
    AND char_length(operator_actor) <= 160
  ),
  CONSTRAINT service_principal_grant_audit_request_correlation_bounded CHECK (
    public.authz_is_ecmascript_trimmed_nonempty(request_correlation)
    AND char_length(request_correlation) <= 160
  ),
  CONSTRAINT service_principal_grant_audit_identity_exact FOREIGN KEY (
    grant_id,
    service_principal_id,
    client_id,
    protected_resource,
    operation_id,
    capability_id,
    resource_id
  ) REFERENCES public.service_principal_grants (
    grant_id,
    service_principal_id,
    client_id,
    protected_resource,
    operation_id,
    capability_id,
    resource_id
  ) ON DELETE RESTRICT
);

CREATE INDEX service_principal_grant_audit_lookup
  ON public.service_principal_grant_audit (grant_id, occurred_at, event_id);

CREATE FUNCTION public.service_principal_grant_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'service-principal grant audit is append-only';
END;
$$;

CREATE TRIGGER service_principal_grant_audit_no_update
  BEFORE UPDATE OR DELETE ON public.service_principal_grant_audit
  FOR EACH ROW EXECUTE FUNCTION public.service_principal_grant_audit_append_only();
