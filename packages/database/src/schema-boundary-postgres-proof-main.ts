import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

const inventory = [
  "organization_global_administrator_grants",
  "economy_payment_authorities",
  "economy_receipt_approval_grants",
  "organization_team_interest_registrations",
  "schools_directory_schools",
  "schools_directory_departments",
  "content_articles",
  "content_article_versions",
  "content_article_departments",
  "content_publication_command_receipts",
  "content_publication_audit",
  "recruitment_interview_schema_questions",
  "recruitment_interview_question_snapshots",
  "recruitment_interview_conducts",
  "recruitment_interview_cancellations",
  "recruitment_interview_lifecycle_command_receipts",
  "recruitment_interview_lifecycle_audit",
] as const;
const schedulingTables = [
  "recruitment_interview_schedules",
  "recruitment_invitations",
  "recruitment_schedule_command_receipts",
  "recruitment_schedule_audit",
  "recruitment_invitation_outbox",
] as const;
const betterAuthTables = ["user", "session", "account", "verification"] as const;
const nativeFunctions = [
  "prevent_content_publication_audit_mutation",
  "prevent_recruitment_interview_question_snapshot_mutation",
  "prevent_recruitment_interview_lifecycle_mutation",
] as const;
const sourcePaths = [
  "../../domain/src/receipt/migrations/0001-receipt-authority.sql",
  "../../domain/src/admission-period/migrations/0001-admission-period-authority.sql",
  "../../domain/src/application/migrations/0002-public-applicant-admission.sql",
  "../../domain/src/receipt/migrations/0001-receipt-authority.sql",
  "../../domain/src/application/migrations/0003-public-applicant-effect-lifecycle.sql",
  "../../domain/src/application/migrations/0004-public-applicant-delivered-payload-cleanup.sql",
  "../../domain/src/application/migrations/0005-public-applicant-activation-snapshot.sql",
  "../../domain/src/organization/migrations/0001-organization-authority.sql",
  "../migrations/0009-import-occurrence-authority.sql",
  "../migrations/0010-native-recruitment-applicant-assignment.sql",
  "../migrations/0011-native-recruitment-interview-scheduling.sql",
  "../migrations/0012-native-recruitment-invitation-response.sql",
  "../migrations/0013-native-organization-administration.sql",
  "../migrations/0014-native-profile-self-edit.sql",
  "../migrations/0015-native-identity-better-auth.sql",
  "../migrations/0016-person-keyed-organization-authority.sql",
  "../migrations/0017-person-keyed-receipt-authority.sql",
  "../migrations/0018-organization-team-interest.sql",
  "../../domain/src/schools/migrations/0001-schools-directory.sql",
  "../../domain/src/content/migrations/0001-content-publication.sql",
  "../migrations/0021-native-recruitment-interview-conduct.sql",
  "../migrations/0022-native-domain-schema-boundary.sql",
].map((path) => new URL(path, import.meta.url));
const historicalSourcePaths = sourcePaths.slice(0, -1);

const databaseUrl = (name: string): string => {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  const parsed = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol));
  assert.ok(
    parsed.hostname === "" || ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname),
  );
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /schema-boundary/u);
  return value;
};

const query = async <T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[] = [],
) => (await client.query<T>(text, values)).rows;

const runSource = async (pool: Pool, sourceUrl: URL): Promise<void> => {
  const source = await readFile(sourceUrl, "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO auth, public");
    await client.query(source);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const runSources = async (pool: Pool, sources: readonly URL[]) => {
  for (const source of sources) await runSource(pool, source);
};

const relationName = (schema: "auth" | "public", table: string) => `"${schema}"."${table}"`;
type CatalogRelation = { table_name: string; schema_name: string };
type CatalogEvidence = {
  relations: CatalogRelation[];
  scheduling: CatalogRelation[];
  auth: Array<{ table_name: string }>;
  publicAuth: Array<{ table_name: string }>;
  identityLink: Array<{ linked: boolean }>;
  functions: Array<{
    function_name: string;
    schema_name: string;
    function_body: string;
  }>;
};
type TableMetadata = {
  columns: QueryResultRow[];
  constraints: QueryResultRow[];
  indexes: QueryResultRow[];
  triggers: Array<{ trigger_name: string; definition: string; function_oid: string }>;
  rules: QueryResultRow[];
};
type TableEvidence = {
  table: string;
  count: string;
  digest: string;
  metadata: TableMetadata;
};

const tableEvidence = async (client: PoolClient, schema: "auth" | "public", table: string) => {
  const relation = relationName(schema, table);
  const rows = await query<{ count: string; digest: string }>(
    client,
    `SELECT count(*)::text AS count,
            md5(COALESCE(string_agg(to_jsonb(row_data)::text, ',' ORDER BY to_jsonb(row_data)::text), '')) AS digest
       FROM ${relation} AS row_data`,
  );
  return rows[0]!;
};

const metadataEvidence = async (
  client: PoolClient,
  schema: "auth" | "public",
  table: string,
): Promise<TableMetadata> => {
  const columns = await query(
    client,
    `
    SELECT column_name, data_type, is_nullable, column_default, ordinal_position
      FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position
  `,
    [schema, table],
  );
  const constraints = await query(
    client,
    `
    SELECT constraint_entry.conname AS constraint_name,
           constraint_entry.contype AS constraint_type,
           pg_catalog.pg_get_constraintdef(constraint_entry.oid) AS definition
      FROM pg_catalog.pg_constraint AS constraint_entry
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = constraint_entry.connamespace
     WHERE namespace.nspname = $1 AND constraint_entry.conrelid = $2::regclass
     ORDER BY constraint_name
  `,
    [schema, `${schema}.${table}`],
  );
  const indexes = await query(
    client,
    `
    SELECT indexname, indexdef
      FROM pg_catalog.pg_indexes
     WHERE schemaname = $1 AND tablename = $2
     ORDER BY indexname
  `,
    [schema, table],
  );
  const triggers = await query<{
    trigger_name: string;
    definition: string;
    function_oid: string;
  }>(
    client,
    `
    SELECT trigger.tgname AS trigger_name, pg_catalog.pg_get_triggerdef(trigger.oid) AS definition,
           trigger.tgfoid::text AS function_oid
      FROM pg_catalog.pg_trigger AS trigger
      INNER JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = $1 AND relation.relname = $2 AND NOT trigger.tgisinternal
     ORDER BY trigger.tgname
  `,
    [schema, table],
  );
  const rules = await query(
    client,
    `
    SELECT rule.rulename, rule.definition
      FROM pg_catalog.pg_rules AS rule
     WHERE rule.schemaname = $1 AND rule.tablename = $2
     ORDER BY rule.rulename
  `,
    [schema, table],
  );
  return { columns, constraints, indexes, triggers, rules };
};

const catalogEvidence = async (client: PoolClient): Promise<CatalogEvidence> => {
  const relations = await query<{ table_name: string; schema_name: string }>(
    client,
    `
    SELECT relation.relname AS table_name, namespace.nspname AS schema_name
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE relation.relname = ANY($1::text[])
       AND namespace.nspname IN ('auth', 'public')
       AND relation.relkind IN ('r', 'p', 'f')
     ORDER BY relation.relname, namespace.nspname
  `,
    [[...inventory]],
  );
  const auth = await query<{ table_name: string }>(
    client,
    `
    SELECT relation.relname AS table_name
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'auth' AND relation.relname = ANY($1::text[])
     ORDER BY relation.relname
  `,
    [[...betterAuthTables]],
  );
  const scheduling = await query<{ table_name: string; schema_name: string }>(
    client,
    `
    SELECT relation.relname AS table_name, namespace.nspname AS schema_name
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE relation.relname = ANY($1::text[]) AND namespace.nspname IN ('auth', 'public')
       AND relation.relkind IN ('r', 'p', 'f')
     ORDER BY relation.relname, namespace.nspname
    `,
    [[...schedulingTables]],
  );
  const publicAuth = await query<{ table_name: string }>(
    client,
    `
    SELECT relation.relname AS table_name
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
     ORDER BY relation.relname
    `,
    [[...betterAuthTables]],
  );
  const identityLink = await query<{ linked: boolean }>(
    client,
    `
    SELECT auth_user."id" = profile.person_id AS linked
      FROM auth."user" AS auth_user
      INNER JOIN public.person_profiles AS profile ON profile.person_id = auth_user."id"
     ORDER BY auth_user."id"
     LIMIT 1
    `,
  );
  const functions = await query<{
    function_name: string;
    schema_name: string;
    function_body: string;
  }>(
    client,
    `
    SELECT procedure.proname AS function_name, namespace.nspname AS schema_name,
           procedure.prosrc AS function_body
      FROM pg_catalog.pg_proc AS procedure
      INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
     WHERE procedure.proname = ANY($1::text[]) AND procedure.pronargs = 0
     ORDER BY procedure.proname, namespace.nspname
    `,
    [[...nativeFunctions]],
  );
  return { relations, scheduling, auth, publicAuth, identityLink, functions };
};

const assertCatalog = (
  catalog: Awaited<ReturnType<typeof catalogEvidence>>,
  schema: "auth" | "public",
  identitySeeded = false,
) => {
  assert.deepEqual(
    catalog.relations,
    [...inventory].sort().map((table_name) => ({ table_name, schema_name: schema })),
  );
  assert.deepEqual(
    catalog.scheduling,
    [...schedulingTables].sort().map((table_name) => ({ table_name, schema_name: "public" })),
  );
  assert.deepEqual(
    catalog.auth,
    [...betterAuthTables].sort().map((table_name) => ({ table_name })),
  );
  assert.deepEqual(catalog.publicAuth, []);
  assert.deepEqual(catalog.identityLink, identitySeeded ? [{ linked: true }] : []);
  assert.deepEqual(
    catalog.functions.map(({ function_name, schema_name }) => ({ function_name, schema_name })),
    [...nativeFunctions].sort().map((function_name) => ({ function_name, schema_name: schema })),
  );
};

const seedParents = async (client: PoolClient) => {
  await client.query(`
    INSERT INTO public.person_profiles (person_id, first_name, last_name, revision)
    VALUES ('schema-boundary-person', 'Schema', 'Boundary', 0), ('schema-boundary-interviewer', 'Interview', 'Person', 0)
  `);
  await client.query(`
    INSERT INTO auth."user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES ('schema-boundary-person', 'Schema Boundary', 'schema-auth@example.invalid', TRUE, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')
  `);
  await client.query(`
    INSERT INTO public.organization_departments (department_id, name, short_name, email, city)
    VALUES ('schema-boundary-department', 'Schema Boundary', 'SBD', 'schema-boundary@example.invalid', 'Oslo')
  `);
  await client.query(`
    INSERT INTO public.organization_teams (team_id, department_id, name)
    VALUES ('schema-boundary-team', 'schema-boundary-department', 'Schema Boundary Team')
  `);
  await client.query(`
    INSERT INTO public.admission_period_departments (department_id, name)
    VALUES ('schema-boundary-department', 'Schema Boundary')
  `);
  await client.query(`
    INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at)
    VALUES ('schema-boundary-semester', '2030-01-01T00:00:00Z', '2030-12-31T00:00:00Z')
  `);
  await client.query(`
    INSERT INTO public.admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, last_command_id)
    VALUES ('schema-boundary-period', 'schema-boundary-department', 'schema-boundary-semester', '2030-01-01T00:00:00Z', '2030-12-31T00:00:00Z', 'schema-boundary-period-command')
  `);
  await client.query(`
    INSERT INTO public.admission_period_fields_of_study (field_of_study_id, department_id, name)
    VALUES ('schema-boundary-field', 'schema-boundary-department', 'Schema Boundary Studies')
  `);
  await client.query(`
    INSERT INTO public.admission_applicants (applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id, year_of_study)
    VALUES ('schema-boundary-applicant', 'schema-boundary@example.invalid', 'schema-boundary@example.invalid', 'Schema', 'Applicant', '90000000', 0, 'schema-boundary-field', 1)
  `);
  await client.query(`
    INSERT INTO public.admission_applications (application_id, applicant_id, admission_period_id, department_id, field_of_study_id, year_of_study, submitted_at)
    VALUES ('schema-boundary-application', 'schema-boundary-applicant', 'schema-boundary-period', 'schema-boundary-department', 'schema-boundary-field', 1, '2030-01-02T00:00:00Z')
  `);
  await client.query(`
    INSERT INTO public.recruitment_interview_schemas (interview_schema_id, name, question_count)
    VALUES ('schema-boundary-schema', 'Schema Boundary Interview', 1)
  `);
  await client.query(`
    INSERT INTO public.recruitment_interviews (interview_id, application_id, department_id, interviewer_person_id, interview_schema_id, assigned_by_person_id, assigned_at)
    VALUES ('schema-boundary-interview', 'schema-boundary-application', 'schema-boundary-department', 'schema-boundary-interviewer', 'schema-boundary-schema', 'schema-boundary-person', '2030-01-03T00:00:00Z')
  `);
};

const seedInventory = async (client: PoolClient, schema: "auth" | "public") => {
  const table = (name: string) => relationName(schema, name);
  await client.query(
    `INSERT INTO ${table("organization_global_administrator_grants")} (grant_id, person_id, start_at, revision) VALUES ('schema-boundary-grant', 'schema-boundary-person', '2030-01-01T00:00:00Z', 0)`,
  );
  await client.query(
    `INSERT INTO ${table("economy_payment_authorities")} (payment_authority_id, person_id, department_id, payment_account_ciphertext, start_at, revision) VALUES ('schema-boundary-payment', 'schema-boundary-person', 'schema-boundary-department', 'ciphertext', '2030-01-01T00:00:00Z', 0)`,
  );
  await client.query(
    `INSERT INTO ${table("economy_receipt_approval_grants")} (approval_grant_id, person_id, scope, start_at, revision) VALUES ('schema-boundary-approval', 'schema-boundary-person', 'Global', '2030-01-01T00:00:00Z', 0)`,
  );
  await client.query(
    `INSERT INTO ${table("organization_team_interest_registrations")} (submitter_name, submitter_email, team_id, department_id, submitted_at) VALUES ('Schema Submitter', 'schema-submitter@example.invalid', 'schema-boundary-team', 'schema-boundary-department', '2030-01-01T00:00:00Z')`,
  );
  await client.query(
    `INSERT INTO ${table("schools_directory_schools")} (name, contact_person, email, phone, language, active) VALUES ('Schema School', 'Schema Contact', 'schema-school@example.invalid', '+47 90000000', 'Norwegian', TRUE)`,
  );
  await client.query(
    `INSERT INTO ${table("schools_directory_departments")} (school_id, department_id) SELECT school_id, 'schema-boundary-department' FROM ${table("schools_directory_schools")} WHERE email = 'schema-school@example.invalid'`,
  );
  await client.query(
    `INSERT INTO ${table("content_articles")} (title, slug, body_html, sticky, created_by_person_id) VALUES ('Schema Article', 'schema-article', '<p>Schema</p>', FALSE, 'schema-boundary-person')`,
  );
  await client.query(
    `INSERT INTO ${table("content_article_versions")} (article_id, version_number, title, slug, body_html, sticky, published_at, published_by_person_id) SELECT article_id, 1, title, slug, body_html, sticky, '2030-01-04T00:00:00Z', 'schema-boundary-person' FROM ${table("content_articles")} WHERE slug = 'schema-article'`,
  );
  await client.query(
    `UPDATE ${table("content_articles")} SET current_version_number = 1 WHERE slug = 'schema-article'`,
  );
  await client.query(
    `INSERT INTO ${table("content_article_departments")} (article_id, department_id) SELECT article_id, 'schema-boundary-department' FROM ${table("content_articles")} WHERE slug = 'schema-article'`,
  );
  await client.query(
    `INSERT INTO ${table("content_publication_command_receipts")} (command_id, article_id, kind, payload_sha256, result_json, committed_at) SELECT 'schema-boundary-content-command', article_id, 'CreateDraft', repeat('a', 64), '{}'::jsonb, '2030-01-04T00:00:00Z' FROM ${table("content_articles")} WHERE slug = 'schema-article'`,
  );
  await client.query(
    `INSERT INTO ${table("content_publication_audit")} (command_id, article_id, actor_person_id, action, occurred_at) SELECT 'schema-boundary-content-command', article_id, 'schema-boundary-person', 'CreateDraft', '2030-01-04T00:00:00Z' FROM ${table("content_articles")} WHERE slug = 'schema-article'`,
  );
  await client.query(
    `INSERT INTO ${table("recruitment_interview_schema_questions")} (interview_schema_id, question_id, ordinal, prompt, kind, alternatives) VALUES ('schema-boundary-schema', 'schema-boundary-question', 0, 'Schema question', 'text', '[]'::jsonb)`,
  );
  await client.query(
    `INSERT INTO ${table("recruitment_interview_question_snapshots")} (interview_id, question_id, ordinal, prompt, kind, alternatives) VALUES ('schema-boundary-interview', 'schema-boundary-question', 0, 'Schema snapshot', 'text', '[]'::jsonb)`,
  );
  await client.query(
    `INSERT INTO ${table("recruitment_interview_conducts")} (interview_id, answers, explanatory_power, role_model, suitability, finalized_by_person_id, finalized_at, interview_revision) VALUES ('schema-boundary-interview', '[]'::jsonb, 8, 9, 7, 'schema-boundary-person', '2030-01-05T00:00:00Z', 0)`,
  );
  await client
    .query(
      `INSERT INTO ${table("recruitment_interview_cancellations")} (interview_id, cancelled_by_person_id, cancelled_at, interview_revision) VALUES ('schema-boundary-interview-cancelled', 'schema-boundary-person', '2030-01-05T00:00:00Z', 0)`,
    )
    .catch(async () => {
      await client
        .query(
          `INSERT INTO public.recruitment_interviews (interview_id, application_id, department_id, interviewer_person_id, interview_schema_id, assigned_by_person_id, assigned_at) VALUES ('schema-boundary-interview-cancelled', 'schema-boundary-application-cancelled', 'schema-boundary-department', 'schema-boundary-interviewer', 'schema-boundary-schema', 'schema-boundary-person', '2030-01-03T00:00:00Z')`,
        )
        .catch(() => undefined);
      await client.query(
        `INSERT INTO ${table("recruitment_interview_cancellations")} (interview_id, cancelled_by_person_id, cancelled_at, interview_revision) VALUES ('schema-boundary-interview', 'schema-boundary-person', '2030-01-05T00:00:00Z', 0)`,
      );
    });
  await client.query(
    `INSERT INTO ${table("recruitment_interview_lifecycle_command_receipts")} (command_id, command_sha256, command_json, observation_json, kind, interview_id, resulting_revision, committed_at) VALUES ('schema-boundary-conduct-command', repeat('b', 64), '{}'::jsonb, '{}'::jsonb, 'InterviewFinalized', 'schema-boundary-interview', 0, '2030-01-05T00:00:00Z')`,
  );
  await client.query(
    `INSERT INTO ${table("recruitment_interview_lifecycle_audit")} (command_id, interview_id, kind, actor_person_id, resulting_revision, occurred_at) VALUES ('schema-boundary-conduct-command', 'schema-boundary-interview', 'InterviewFinalized', 'schema-boundary-person', 0, '2030-01-05T00:00:00Z')`,
  );
};

const evidenceForSchema = async (
  client: PoolClient,
  schema: "auth" | "public",
): Promise<TableEvidence[]> => {
  const rows: TableEvidence[] = [];
  for (const table of inventory)
    rows.push({
      table,
      ...(await tableEvidence(client, schema, table)),
      metadata: await metadataEvidence(client, schema, table),
    });
  return rows;
};
type SchemaEvidence = {
  catalog: CatalogEvidence;
  tables: TableEvidence[];
};
const normalizeSql = (value: string) => value.replace(/\b(?:auth|public)\./g, "");
const normalizeMetadataRecord = (record: QueryResultRow) =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      typeof value === "string" ? normalizeSql(value) : value,
    ]),
  );
const comparableTables = (tables: TableEvidence[]) =>
  tables.map(({ table, count, digest, metadata }) => ({
    table,
    count,
    digest,
    metadata: {
      columns: metadata.columns.map(normalizeMetadataRecord),
      constraints: metadata.constraints.map(normalizeMetadataRecord),
      indexes: metadata.indexes.map(normalizeMetadataRecord),
      triggers: metadata.triggers.map(({ trigger_name, definition }) => ({
        trigger_name,
        definition: normalizeSql(definition),
      })),
      rules: metadata.rules.map(normalizeMetadataRecord),
    },
  }));

const assertImmutableMutations = async (client: PoolClient) => {
  const mutations = [
    `UPDATE public.content_publication_audit SET command_id = command_id`,
    `DELETE FROM public.content_publication_audit`,
    `UPDATE public.recruitment_interview_question_snapshots SET prompt = prompt`,
    `DELETE FROM public.recruitment_interview_question_snapshots`,
    `UPDATE public.recruitment_interview_conducts SET answers = answers`,
    `DELETE FROM public.recruitment_interview_conducts`,
    `UPDATE public.recruitment_interview_cancellations SET interview_id = interview_id`,
    `DELETE FROM public.recruitment_interview_cancellations`,
    `UPDATE public.recruitment_interview_lifecycle_command_receipts SET command_id = command_id`,
    `DELETE FROM public.recruitment_interview_lifecycle_command_receipts`,
    `UPDATE public.recruitment_interview_lifecycle_audit SET command_id = command_id`,
    `DELETE FROM public.recruitment_interview_lifecycle_audit`,
  ];
  for (const statement of mutations) await assert.rejects(() => client.query(statement));
};

const runNormalDatabaseRead = async (url: string) => {
  const pool = new Pool({
    connectionString: url,
    max: 1,
    options: "-c search_path=auth,public",
    application_name: "schema-boundary-proof",
  });
  const client = await pool.connect();
  try {
    return await query<{ readonly count: string }>(
      client,
      `SELECT count(*)::text AS "count" FROM public.recruitment_interview_question_snapshots`,
    );
  } finally {
    client.release();
    await pool.end();
  }
};

const main = async () => {
  const freshPool = new Pool({
    connectionString: databaseUrl("SCHEMA_BOUNDARY_FRESH_DATABASE_URL"),
    max: 1,
  });
  const upgradePool = new Pool({
    connectionString: databaseUrl("SCHEMA_BOUNDARY_UPGRADE_DATABASE_URL"),
    max: 1,
  });
  const collisionPool = new Pool({
    connectionString: databaseUrl("SCHEMA_BOUNDARY_COLLISION_DATABASE_URL"),
    max: 1,
  });
  try {
    await runSources(freshPool, sourcePaths);
    const freshClient = await freshPool.connect();
    let freshCatalog: CatalogEvidence;
    try {
      await seedParents(freshClient);
      await freshClient.query("SET search_path TO auth, public");
      await seedInventory(freshClient, "public");
      freshCatalog = await catalogEvidence(freshClient);
      assertCatalog(freshCatalog, "public", true);
    } finally {
      freshClient.release();
    }
    const normalRuntimeRead = await runNormalDatabaseRead(
      databaseUrl("SCHEMA_BOUNDARY_FRESH_DATABASE_URL"),
    );
    assert.deepEqual(normalRuntimeRead, [{ count: "1" }]);

    await runSources(upgradePool, historicalSourcePaths);
    const upgradeClient = await upgradePool.connect();
    let before: SchemaEvidence;
    try {
      await seedParents(upgradeClient);
      await upgradeClient.query("SET search_path TO auth, public");
      await seedInventory(upgradeClient, "auth");
      before = {
        catalog: await catalogEvidence(upgradeClient),
        tables: await evidenceForSchema(upgradeClient, "auth"),
      };
      assertCatalog(before.catalog, "auth", true);
    } finally {
      upgradeClient.release();
    }
    await runSource(upgradePool, sourcePaths.at(-1)!);
    const afterClient = await upgradePool.connect();
    let after: SchemaEvidence;
    try {
      after = {
        catalog: await catalogEvidence(afterClient),
        tables: await evidenceForSchema(afterClient, "public"),
      };
      assertCatalog(after.catalog, "public", true);
      assert.deepEqual(after.catalog, freshCatalog);
      assert.deepEqual(comparableTables(after.tables), comparableTables(before.tables));
      assert.deepEqual(
        after.catalog.functions.map(({ function_name, function_body }) => ({
          function_name,
          function_body,
        })),
        before.catalog.functions.map(({ function_name, function_body }) => ({
          function_name,
          function_body,
        })),
      );
      await assertImmutableMutations(afterClient);
      await afterClient.query("SET search_path TO auth, public");
      await afterClient.query("CREATE TABLE auth.content_articles (article_id bigint NOT NULL)");
      await afterClient.query("INSERT INTO auth.content_articles VALUES (1)");
      const readInventory = async () => {
        const rows = [];
        for (const table of inventory)
          rows.push({
            table,
            value: await query(
              afterClient,
              `SELECT count(*)::text AS count FROM public."${table}"`,
            ),
          });
        return rows;
      };
      const authFirst = await readInventory();
      await afterClient.query("SET search_path TO public");
      const publicFirst = await readInventory();
      assert.deepEqual(authFirst, publicFirst);
      await afterClient.query("DROP TABLE auth.content_articles");
      await afterClient.query("SET search_path TO auth, public");
    } finally {
      afterClient.release();
    }
    await runSource(upgradePool, sourcePaths.at(-1)!);
    const secondClient = await upgradePool.connect();
    try {
      const afterSecond: SchemaEvidence = {
        catalog: await catalogEvidence(secondClient),
        tables: await evidenceForSchema(secondClient, "public"),
      };
      assertCatalog(afterSecond.catalog, "public", true);
      assert.deepEqual(afterSecond.catalog, after.catalog);
      assert.deepEqual(comparableTables(afterSecond.tables), comparableTables(after.tables));
    } finally {
      secondClient.release();
    }

    await runSources(collisionPool, historicalSourcePaths);
    const collisionClient = await collisionPool.connect();
    await collisionClient.query(
      "CREATE TABLE public.content_articles (article_id bigint NOT NULL)",
    );
    await collisionClient.query(`
      CREATE FUNCTION public.prevent_content_publication_audit_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NEW; END;
      $$;
    `);
    collisionClient.release();
    await assert.rejects(() => runSource(collisionPool, sourcePaths.at(-1)!));
    const rollbackClient = await collisionPool.connect();
    try {
      const rollback = await catalogEvidence(rollbackClient);
      assert.deepEqual(
        rollback.relations
          .filter(({ schema_name }) => schema_name === "auth")
          .map(({ table_name }) => table_name)
          .sort(),
        [...inventory].sort(),
      );
      assert.deepEqual(
        rollback.relations
          .filter(({ schema_name }) => schema_name === "public")
          .map(({ table_name }) => table_name)
          .sort(),
        ["content_articles"],
      );
      assert.deepEqual(
        rollback.functions
          .map(({ function_name, schema_name }) => ({ function_name, schema_name }))
          .sort((left, right) =>
            `${left.function_name}.${left.schema_name}`.localeCompare(
              `${right.function_name}.${right.schema_name}`,
            ),
          ),
        [
          { function_name: "prevent_content_publication_audit_mutation", schema_name: "auth" },
          { function_name: "prevent_content_publication_audit_mutation", schema_name: "public" },
          {
            function_name: "prevent_recruitment_interview_lifecycle_mutation",
            schema_name: "auth",
          },
          {
            function_name: "prevent_recruitment_interview_question_snapshot_mutation",
            schema_name: "auth",
          },
        ],
      );
      assert.equal(
        rollback.functions.filter(
          ({ function_name, schema_name }) =>
            function_name === "prevent_content_publication_audit_mutation" &&
            schema_name === "public",
        ).length,
        1,
      );
    } finally {
      rollbackClient.release();
    }
    process.stdout.write(
      `${JSON.stringify({
        passed: true,
        inventory,
        fresh: freshCatalog,
        upgradeBefore: before.catalog,
        upgradeAfter: after.catalog,
        collisionRollback: true,
      })}\n`,
    );
  } finally {
    await Promise.all([freshPool.end(), upgradePool.end(), collisionPool.end()]);
  }
};

await main();
