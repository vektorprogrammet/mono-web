import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { Cause, Effect, Option, Redacted } from "effect";
import { isSqlError } from "effect/unstable/sql/SqlError";
import { DatabaseLive } from "./layers.js";
import { databaseMigrationDefinitions } from "./migrations.js";

const expectedFailures = [
  { reasonCode: "INTERVAL_INVALID", ruleId: "migration-preflight-interval" },
  { reasonCode: "REVISION_INVALID", ruleId: "migration-preflight-revision" },
  { reasonCode: "SCOPE_COLUMNS_INVALID", ruleId: "migration-preflight-scope-columns" },
  { reasonCode: "SCOPE_REFERENCE_MISSING", ruleId: "migration-preflight-scope-reference" },
  { reasonCode: "SUBJECT_COLUMNS_INVALID", ruleId: "migration-preflight-subject-columns" },
  { reasonCode: "SUBJECT_REFERENCE_MISSING", ruleId: "migration-preflight-subject-reference" },
  { reasonCode: "VARIANT_INVALID", ruleId: "migration-preflight-variant" },
] as const;

const reset = (sql: DatabaseShape) =>
  sql
    .unsafe(`
      DROP SCHEMA IF EXISTS auth CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `)
    .pipe(Effect.asVoid, Effect.orDie);

const executeMigration = (sql: DatabaseShape, index: number) =>
  Effect.tryPromise(() => readFile(databaseMigrationDefinitions[index]!.url, "utf8")).pipe(
    Effect.flatMap((source) => sql.unsafe(source)),
    Effect.asVoid,
  );

const migrateThrough25 = (sql: DatabaseShape) =>
  Effect.forEach(
    databaseMigrationDefinitions.slice(0, -1),
    (_, index) => executeMigration(sql, index),
    { discard: true },
  );

const migrate26 = (sql: DatabaseShape) =>
  executeMigration(sql, databaseMigrationDefinitions.length - 1);

const prepareMigration25State = (sql: DatabaseShape) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`
      INSERT INTO public.person_profiles (person_id, first_name, last_name)
      VALUES ('migration-preflight-person', 'Migration', 'Preflight');
      INSERT INTO public.organization_departments (
        department_id, name, short_name, email, city
      ) VALUES (
        'migration-preflight-department', 'Migration preflight',
        'MP', 'migration-preflight@example.invalid', 'Oslo'
      );
      INSERT INTO public.authz_tags (tag_id, name, revision)
      VALUES ('migration-preflight-tag', 'Migration preflight', 0);
    `);
    yield* sql.unsafe(`
      ALTER TABLE public.authz_rules
        DROP CONSTRAINT authz_rules_subject_person_id_fkey,
        DROP CONSTRAINT authz_rules_subject_tag_id_fkey,
        DROP CONSTRAINT authz_rules_department_id_fkey,
        DROP CONSTRAINT authz_rules_subject_declared,
        DROP CONSTRAINT authz_rules_scope_declared,
        DROP CONSTRAINT authz_rules_params_declared,
        DROP CONSTRAINT authz_rules_interval_ordered,
        DROP CONSTRAINT authz_rules_revision_nonnegative;
      ALTER TABLE public.authz_rules
        ADD CONSTRAINT authz_rules_params_declared CHECK (true);
    `);
  });

const insertValidRows = (sql: DatabaseShape) =>
  sql.unsafe(`
    INSERT INTO public.authz_rules (
      rule_id, capability_id, effect_kind, subject_kind,
      subject_person_id, subject_tag_id, scope, domain_id, department_id,
      params, start_at, end_at, revision
    ) VALUES
      (
        'migration-preflight-valid-global', 'approveReceipt', 'delegate', 'Person',
        'migration-preflight-person', NULL, 'Global', NULL, NULL,
        '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, 0
      ),
      (
        'migration-preflight-valid-domain', 'approveReceipt', 'requirement', 'Tag',
        NULL, 'migration-preflight-tag', 'Domain', 'receipts', NULL,
        '{"requirementId":"receipts.pending","parameters":{}}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, 0
      ),
      (
        'migration-preflight-valid-department', 'approveReceipt', 'requirement', 'Person',
        'migration-preflight-person', NULL, 'Department', NULL,
        'migration-preflight-department',
        '{"requirementId":"receipts.approver-relationship","parameters":{}}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, 0
      ),
      (
        'migration-preflight-valid-payment', 'submitReceipt', 'delegate', 'Person',
        'migration-preflight-person', NULL, 'Domain', 'receipts', NULL,
        '{"slot":"EconomyPaymentAuthority","paymentAccountCiphertext":"preflight-secret-ciphertext"}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, 0
      );
  `);

const insertInvalidRows = (sql: DatabaseShape) =>
  sql.unsafe(`
    INSERT INTO public.authz_rules (
      rule_id, capability_id, effect_kind, subject_kind,
      subject_person_id, subject_tag_id, scope, domain_id, department_id,
      params, start_at, end_at, revision
    ) VALUES
      (
        'migration-preflight-subject-columns', 'approveReceipt', 'delegate', 'Person',
        'migration-preflight-person', 'migration-preflight-tag', 'Global', NULL, NULL,
        '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, 0
      ),
      (
        'migration-preflight-subject-reference', 'approveReceipt', 'delegate', 'Person',
        'migration-preflight-missing-person', NULL, 'Global', NULL, NULL,
        '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, 0
      ),
      (
        'migration-preflight-scope-columns', 'approveReceipt', 'delegate', 'Person',
        'migration-preflight-person', NULL, 'Global', 'receipts', NULL,
        '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, 0
      ),
      (
        'migration-preflight-scope-reference', 'approveReceipt', 'delegate', 'Person',
        'migration-preflight-person', NULL, 'Department', NULL,
        'migration-preflight-missing-department',
        '{"slot":"EconomyDepartmentApprovalGrant"}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, 0
      ),
      (
        'migration-preflight-interval', 'approveReceipt', 'delegate', 'Person',
        'migration-preflight-person', NULL, 'Global', NULL, NULL,
        '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
        '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', 0
      ),
      (
        'migration-preflight-revision', 'approveReceipt', 'delegate', 'Person',
        'migration-preflight-person', NULL, 'Global', NULL, NULL,
        '{"slot":"EconomyGlobalReceiptApprovalGrant"}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, -1
      ),
      (
        'migration-preflight-variant', 'approveReceipt', 'parameter', 'Person',
        'migration-preflight-person', NULL, 'Global', NULL, NULL,
        '{"slot":"unsupported","private":"do-not-report"}'::jsonb,
        '2030-01-01T00:00:00.000Z', NULL, 0
      );
  `);

const parseReport = (failure: string): ReadonlyArray<unknown> => {
  const prefix = "authz_rules preflight failed: ";
  const start = failure.indexOf(prefix);
  assert.notEqual(start, -1);
  return JSON.parse(failure.slice(start + prefix.length)) as ReadonlyArray<unknown>;
};

export const proveRuleReconciliationMigration = (databaseUrl: Redacted.Redacted<string>) => {
  const layer = DatabaseLive({
    url: Redacted.make(Redacted.value(databaseUrl)),
    applicationName: "rule-reconciliation-migration-proof-0056-2",
    maxConnections: 1,
  });
  return Effect.gen(function* () {
    const sql = yield* Database;
    yield* reset(sql);
    yield* migrateThrough25(sql);
    yield* prepareMigration25State(sql);
    yield* insertValidRows(sql);
    yield* insertInvalidRows(sql);
    const failed = yield* Effect.exit(migrate26(sql));
    assert.equal(failed._tag, "Failure");
    if (failed._tag !== "Failure") throw new Error("migration 26 unexpectedly succeeded");
    const failureOption = Cause.findErrorOption(failed.cause);
    assert(Option.isSome(failureOption));
    assert(isSqlError(failureOption.value));
    const databaseCause = failureOption.value.reason.cause;
    const failure = databaseCause instanceof Error ? databaseCause.message : String(databaseCause);
    assert.deepEqual(parseReport(failure), expectedFailures);
    assert.equal(failure.includes("preflight-secret-ciphertext"), false);
    assert.equal(failure.includes("do-not-report"), false);
    assert.equal(failure.includes("migration-preflight-valid-"), false);
    const [preserved] = yield* sql<{ readonly definition: string }>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'public.authz_rules'::regclass
        AND conname = 'authz_rules_params_declared'
    `;
    assert.equal(preserved?.definition, "CHECK (true)");

    yield* reset(sql);
    yield* migrateThrough25(sql);
    yield* prepareMigration25State(sql);
    yield* insertValidRows(sql);
    yield* migrate26(sql);
    const validRows = yield* sql<{ readonly ruleId: string }>`
      SELECT rule_id AS "ruleId"
      FROM public.authz_rules
      ORDER BY rule_id
    `;
    assert.deepEqual(
      validRows.map(({ ruleId }) => ruleId),
      [
        "migration-preflight-valid-department",
        "migration-preflight-valid-domain",
        "migration-preflight-valid-global",
        "migration-preflight-valid-payment",
      ],
    );
    return {
      invalidRows: expectedFailures,
      preservedConstraint: preserved.definition,
      validRuleIds: validRows.map(({ ruleId }) => ruleId),
    };
  }).pipe(Effect.ensuring(Database.use(reset)), Effect.provide(layer));
};
