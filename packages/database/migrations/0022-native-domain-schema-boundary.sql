-- Forward correction for the complete post-0015 native inventory checked in
-- design-specs/0066.1-native-domain-schema-boundary-amendment.md.
-- The migration runner supplies the transaction boundary for this migration.

DO $migration$
DECLARE
  inventory_table text;
  inventory_tables CONSTANT text[] := ARRAY[
    'organization_global_administrator_grants',
    'economy_payment_authorities',
    'economy_receipt_approval_grants',
    'organization_team_interest_registrations',
    'schools_directory_schools',
    'schools_directory_departments',
    'content_articles',
    'content_article_versions',
    'content_article_departments',
    'content_publication_command_receipts',
    'content_publication_audit',
    'recruitment_interview_schema_questions',
    'recruitment_interview_question_snapshots',
    'recruitment_interview_conducts',
    'recruitment_interview_cancellations',
    'recruitment_interview_lifecycle_command_receipts',
    'recruitment_interview_lifecycle_audit'
  ]::text[];
  native_function text;
  native_functions CONSTANT text[] := ARRAY[
    'prevent_content_publication_audit_mutation',
    'prevent_recruitment_interview_question_snapshot_mutation',
    'prevent_recruitment_interview_lifecycle_mutation'
  ]::text[];
  colliding_tables text[] := ARRAY[]::text[];
  colliding_functions text[] := ARRAY[]::text[];
BEGIN
  -- Preflight every table before moving any relation. pg_catalog and explicit
  -- namespace predicates keep this independent of search_path.
  FOREACH inventory_table IN ARRAY inventory_tables LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'auth'
        AND relation.relname = inventory_table
    ) AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = inventory_table
    ) THEN
      colliding_tables := array_append(colliding_tables, inventory_table);
    END IF;
  END LOOP;

  -- These functions are created by the historical unqualified 0020/0021
  -- migrations. Preflight function collisions so trigger targets cannot be
  -- ambiguous after the table transfer.
  FOREACH native_function IN ARRAY native_functions LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'auth'
        AND procedure.proname = native_function
        AND procedure.pronargs = 0
    ) AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = native_function
        AND procedure.pronargs = 0
    ) THEN
      colliding_functions := array_append(colliding_functions, native_function || '()');
    END IF;
  END LOOP;

  IF cardinality(colliding_tables) > 0 OR cardinality(colliding_functions) > 0 THEN
    RAISE EXCEPTION
      'Native schema-boundary collision; review before retrying (tables: %, functions: %)',
      COALESCE(array_to_string(colliding_tables, ', '), '<none>'),
      COALESCE(array_to_string(colliding_functions, ', '), '<none>')
      USING ERRCODE = 'duplicate_table';
  END IF;

  FOREACH inventory_table IN ARRAY inventory_tables LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'auth'
        AND relation.relname = inventory_table
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = inventory_table
    ) THEN
      EXECUTE format('ALTER TABLE %I.%I SET SCHEMA public', 'auth', inventory_table);
    END IF;
  END LOOP;

  FOREACH native_function IN ARRAY native_functions LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'auth'
        AND procedure.proname = native_function
        AND procedure.pronargs = 0
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = native_function
        AND procedure.pronargs = 0
    ) THEN
      EXECUTE format('ALTER FUNCTION %I.%I() SET SCHEMA public', 'auth', native_function);
    END IF;
  END LOOP;
END
$migration$;
