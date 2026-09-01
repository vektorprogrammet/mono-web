ALTER TABLE public.authz_rules
  ADD COLUMN IF NOT EXISTS domain_id text NULL;

UPDATE public.authz_rules
SET scope = 'Domain', domain_id = 'receipts'
WHERE scope = 'Receipt';

ALTER TABLE public.authz_rules
  DROP CONSTRAINT IF EXISTS authz_rules_scope_declared;

ALTER TABLE public.authz_rules
  ADD CONSTRAINT authz_rules_scope_declared CHECK (
    (scope = 'Global' AND domain_id IS NULL AND department_id IS NULL)
    OR (
      scope = 'Domain'
      AND domain_id IS NOT NULL
      AND domain_id = 'receipts'
      AND department_id IS NULL
    )
    OR (scope = 'Department' AND domain_id IS NULL AND department_id IS NOT NULL)
  );

ALTER TABLE public.authz_rules
  ADD CONSTRAINT authz_rules_domain_id_trimmed_nonempty CHECK (
    domain_id IS NULL OR public.authz_is_ecmascript_trimmed_nonempty(domain_id)
  );
