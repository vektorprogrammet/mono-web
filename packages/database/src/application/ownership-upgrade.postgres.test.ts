/** EX-0021: Stable SQL modules carry an upstream unstable annotation.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Redacted } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect, layer } from "@effect/vitest";
import { type DisposablePostgres, startDisposablePostgres } from "@monoweb/postgres";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { type DatabaseMigrationDefinition, selectDatabaseMigration } from "../migrations.js";
import { executePostgresMigration } from "../postgres-migration-statements.js";
import { TestPlatform } from "../test-support/platform.js";
import { postgresTestClient, withPostgresTestDatabase } from "../test-support/postgres.js";
import { NativeDatabaseStartupOptions } from "../search-path.js";

/**
 * R7 upgrade proof. Seed the registered 82 schema, including one linked applicant shared by
 * two historical periods, then upgrade from 82 or the registered 83 predecessor. Neither path
 * invents an identity, rewrites old evidence, or needs the retired global email uniqueness.
 * PostgreSQL major selection belongs to the existing disposable-cluster harness.
 */
class OwnershipUpgradeCluster extends Context.Service<
  OwnershipUpgradeCluster,
  DisposablePostgres
>()(
  "@vektorprogrammet/database/application/ownership-upgrade.postgres.test/OwnershipUpgradeCluster",
) {}

const cluster = Layer.effect(
  OwnershipUpgradeCluster,
  Effect.acquireRelease(
    Effect.promise(() => startDisposablePostgres({ listen: "socket", maxConnections: 8 })),
    (postgres) => Effect.promise(() => postgres.stop()),
  ),
);

const readSql = Effect.fnUntraced(function* (migration: DatabaseMigrationDefinition) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.readFileString(yield* path.fromFileUrl(migration.url));
});

const seed = `
INSERT INTO public.admission_period_departments (department_id, name)
  VALUES ('ownership-department', 'Ownership');
INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at) VALUES
  ('ownership-semester-1', '2031-01-01', '2031-07-01'),
  ('ownership-semester-2', '2031-07-01', '2032-01-01'),
  ('ownership-semester-3', '2032-01-01', '2032-07-01');
INSERT INTO public.admission_periods
  (admission_period_id, department_id, semester_id, start_at, end_at, last_command_id) VALUES
  ('ownership-period-1', 'ownership-department', 'ownership-semester-1', '2031-01-01', '2031-03-01', 'period-1-created'),
  ('ownership-period-2', 'ownership-department', 'ownership-semester-2', '2031-07-01', '2031-09-01', 'period-2-created'),
  ('ownership-period-3', 'ownership-department', 'ownership-semester-3', '2032-01-01', '2032-03-01', 'period-3-created');
INSERT INTO public.admission_period_fields_of_study (field_of_study_id, department_id, name)
  VALUES ('ownership-field', 'ownership-department', 'Math');
INSERT INTO public.person_profiles (person_id, first_name, last_name)
  VALUES ('ownership-person', 'Original', 'Owner');
INSERT INTO auth."user" (id, name, email, "emailVerified")
  VALUES ('ownership-person', 'Original Owner', 'owner@example.invalid', true);
INSERT INTO public.admission_applicants
  (applicant_id, normalized_email, email, first_name, last_name, phone, gender,
   field_of_study_id, year_of_study, activation_digest)
  VALUES ('ownership-original', 'same@example.invalid', 'same@example.invalid', 'Original',
    'Owner', '90000001', 1, 'ownership-field', 2, repeat('a', 64));
INSERT INTO public.admission_applications
  (application_id, applicant_id, admission_period_id, department_id, field_of_study_id,
   year_of_study, submitted_at, activation_digest) VALUES
  ('ownership-application-1', 'ownership-original', 'ownership-period-1', 'ownership-department',
    'ownership-field', 2, '2031-02-01', repeat('b', 64)),
  ('ownership-application-2', 'ownership-original', 'ownership-period-2', 'ownership-department',
    'ownership-field', 3, '2031-08-01', NULL);
INSERT INTO public.admission_application_command_receipts
  (command_id, command_sha256, command_json, observation_json, application_id, committed_at)
  SELECT 'ownership-command-' || n, repeat('c', 64),
    jsonb_build_object('commandId', 'ownership-command-' || n, 'email', 'same@example.invalid'),
    jsonb_build_object('_tag', 'Submitted', 'commandId', 'ownership-command-' || n,
      'applicationId', 'ownership-application-' || n),
    'ownership-application-' || n, CASE n WHEN 1 THEN '2031-02-01' ELSE '2031-08-01' END::timestamptz
  FROM generate_series(1, 2) AS n;
INSERT INTO public.admission_application_audit
  (command_id, application_id, applicant_id, action, application_revision, occurred_at)
  SELECT command_id, application_id, 'ownership-original', 'PublicApplicationSubmitted', 0,
    committed_at FROM public.admission_application_command_receipts;
INSERT INTO public.admission_application_outbox
  (effect_id, effect_type, application_id, applicant_id, command_id, ordinal, payload_json, status,
   attempts, claim_id, claimed_at, last_failure_tag)
  SELECT 'ownership-effect-' || n || '-' || ordinal,
    CASE ordinal WHEN 0 THEN 'SendApplicantActivationOrConfirmation'
      WHEN 1 THEN 'CreateAdmissionSubscription' ELSE 'WriteApplicationAudit' END,
    'ownership-application-' || n, 'ownership-original', 'ownership-command-' || n, ordinal,
    CASE WHEN n = 1 THEN '{}'::jsonb
      ELSE jsonb_build_object('departmentId', 'ownership-department', 'historicalEnvelope', n) END,
    CASE WHEN n = 1 THEN 'Delivered' WHEN ordinal = 1 THEN 'Processing' ELSE 'Pending' END,
    CASE WHEN n = 1 OR ordinal = 1 THEN 1 ELSE 0 END,
    CASE WHEN n = 2 AND ordinal = 1 THEN 'ownership-claim' END,
    CASE WHEN n = 2 AND ordinal = 1 THEN '2031-08-01'::timestamptz END,
    NULL
  FROM generate_series(1, 2) AS n CROSS JOIN generate_series(0, 2) AS ordinal;
INSERT INTO public.applicant_account_invitations
  (invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by, issued_at)
  VALUES ('ownership-invitation', 'ownership-application-1', 'ownership-original', repeat('d', 64),
    '2031-02-03', 'Claimed', 'ownership-person', '2031-02-02');
INSERT INTO public.applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
  VALUES ('ownership-original', 'ownership-person', '2031-02-02', 'ownership-invitation');
INSERT INTO public.admission_application_outcomes
  (application_id, revision, outcome, decided_by_person_id, decided_at, provenance)
  VALUES ('ownership-application-1', 1, 'Admitted', 'ownership-person', '2031-02-02', 'Decision');
`;

// Read complete old rows. The new email key and 83 fence counter are checked separately;
// outcome columns are the 82 columns, not 83's added citation representation.
const snapshotSql = `SELECT
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY applicant_id) FROM public.admission_applicants a) AS applicants,
  (SELECT jsonb_agg(to_jsonb(a) - 'normalized_email' - 'decision_fence_version' ORDER BY application_id)
    FROM public.admission_applications a) AS applications,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY applicant_id) FROM public.applicant_account_links l) AS links,
  (SELECT jsonb_agg(to_jsonb(i) ORDER BY invitation_id) FROM public.applicant_account_invitations i) AS invitations,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY person_id) FROM public.person_profiles p) AS people,
  (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM auth."user" u) AS users,
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM public.admission_application_command_receipts r) AS receipts,
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY command_id) FROM public.admission_application_audit a) AS audit,
  (SELECT jsonb_agg(to_jsonb(o) ORDER BY effect_id) FROM public.admission_application_outbox o) AS outbox,
  (SELECT jsonb_agg(to_jsonb(h) ORDER BY application_id, revision) FROM (
    SELECT application_id, revision, outcome, decided_by_person_id, decided_at, provenance
    FROM public.admission_application_outcomes
  ) h) AS history`;

const Snapshot = Schema.Struct({
  applicants: Schema.Array(Schema.Json),
  applications: Schema.Array(Schema.Json),
  links: Schema.Array(Schema.Json),
  invitations: Schema.Array(Schema.Json),
  people: Schema.Array(Schema.Json),
  users: Schema.Array(Schema.Json),
  receipts: Schema.Array(Schema.Json),
  audit: Schema.Array(Schema.Json),
  outbox: Schema.Array(Schema.Json),
  history: Schema.Array(Schema.Json),
});

const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot, { onExcessProperty: "error" });

const snapshot = Effect.fnUntraced(function* (pool: SqlClient.SqlClient) {
  const result = yield* pool.unsafe(snapshotSql);

  return yield* decodeSnapshot(result[0]);
});

// PGlite's socket adapter can end a failed connection. Observe SQLSTATE and roll back the
// attempted statement in a server-side subtransaction, identically on PGlite and PostgreSQL.
const observers = `CREATE FUNCTION public.ownership_attempt(statement text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
    RAISE EXCEPTION 'attempt undone' USING ERRCODE = 'RB001';
  EXCEPTION WHEN SQLSTATE 'RB001' THEN
    RETURN 'accepted';
  END;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;`;

const decodeAttempt = Schema.decodeUnknownEffect(
  Schema.Struct({
    outcome: Schema.Literals(["accepted", "23505", "23514", "23503"]),
  }),
);

const attempt = Effect.fnUntraced(function* (pool: SqlClient.SqlClient, statement: string) {
  const result = yield* pool.unsafe("SELECT public.ownership_attempt($1) AS outcome", [statement]);

  return (yield* decodeAttempt(result[0])).outcome;
});

const insertApplication = (id: string, applicant: string, period: string, email?: string) =>
  `INSERT INTO public.admission_applications
    (application_id, applicant_id, admission_period_id, department_id, field_of_study_id,
     year_of_study, submitted_at${email === undefined ? "" : ", normalized_email"})
    VALUES ('${id}', '${applicant}', '${period}', 'ownership-department', 'ownership-field', 2,
      '2032-02-01'${email === undefined ? "" : `, '${email}'`})`;

const proveUpgrade = Effect.fnUntraced(function* (pool: SqlClient.SqlClient, predecessor: 82 | 83) {
  const repair = selectDatabaseMigration("84_application-email-period-ownership");
  const last = repair.preceding.at(-1);
  expect(last?.id.startsWith("83_")).toBe(true);
  const baseline = selectDatabaseMigration("82_admission-outcome-mail");
  const between = repair.preceding.slice(baseline.preceding.length + 1);
  yield* pool.withTransaction(
    executePostgresMigration(seed).pipe(Effect.provideService(SqlClient.SqlClient, pool)),
  );
  const historical = yield* snapshot(pool);
  expect(
    Object.fromEntries(Object.entries(historical).map(([name, rows]) => [name, rows.length])),
  ).toEqual({
    applicants: 1,
    applications: 2,
    links: 1,
    invitations: 1,
    people: 1,
    users: 1,
    receipts: 2,
    audit: 2,
    outbox: 6,
    history: 1,
  });

  if (predecessor === 83) {
    for (const migration of between)
      yield* pool.withTransaction(
        executePostgresMigration(yield* readSql(migration)).pipe(
          Effect.provideService(SqlClient.SqlClient, pool),
        ),
      );
  }

  const before = yield* snapshot(pool);

  if (predecessor === 82) {
    for (const migration of between)
      yield* pool.withTransaction(
        executePostgresMigration(yield* readSql(migration)).pipe(
          Effect.provideService(SqlClient.SqlClient, pool),
        ),
      );
  }

  yield* pool.withTransaction(
    executePostgresMigration(yield* readSql(repair.migration)).pipe(
      Effect.provideService(SqlClient.SqlClient, pool),
    ),
  );
  expect(yield* snapshot(pool)).toEqual(before);
  expect(yield* snapshot(pool)).toEqual(historical);

  const keys = yield* pool.unsafe(`SELECT application_id AS id, normalized_email AS email,
  decision_fence_version::text AS fence FROM public.admission_applications ORDER BY application_id`);

  expect(
    yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          email: Schema.String,
          fence: Schema.Literal("0"),
        }),
      ),
    )(keys),
  ).toEqual([
    { id: "ownership-application-1", email: "same@example.invalid", fence: "0" },
    { id: "ownership-application-2", email: "same@example.invalid", fence: "0" },
  ]);

  // A different, unlinked statement can reuse the address. A period cannot acquire two of them.
  yield* pool.unsafe(`INSERT INTO public.admission_applicants
  (applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id,
   year_of_study, activation_digest)
  VALUES ('ownership-new', 'same@example.invalid', 'same@example.invalid', 'New', 'Statement',
    '90000002', 0, 'ownership-field', 4, repeat('e', 64))`);
  yield* executePostgresMigration(observers).pipe(Effect.provideService(SqlClient.SqlClient, pool));
  expect(
    yield* attempt(
      pool,
      insertApplication("ownership-duplicate", "ownership-new", "ownership-period-1"),
    ),
  ).toBe("23505");
  expect(
    yield* attempt(
      pool,
      insertApplication("ownership-next", "ownership-new", "ownership-period-3"),
    ),
  ).toBe("accepted");
  expect(
    yield* attempt(
      pool,
      insertApplication(
        "ownership-forged-email",
        "ownership-new",
        "ownership-period-3",
        "other@example.invalid",
      ),
    ),
  ).toBe("23514");

  for (const assignment of [
    "applicant_id = 'ownership-renamed'",
    "normalized_email = 'other@example.invalid'",
    "email = 'other@example.invalid'",
    "first_name = 'Changed'",
    "last_name = 'Changed'",
    "phone = '90000009'",
    "gender = 0",
    "field_of_study_id = 'other-field'",
    "year_of_study = 5",
    "activation_digest = repeat('f', 64)",
  ]) {
    expect(
      yield* attempt(
        pool,
        `UPDATE public.admission_applicants SET ${assignment}
      WHERE applicant_id = 'ownership-original'`,
      ),
    ).toBe("23514");
  }

  expect(
    yield* attempt(
      pool,
      "DELETE FROM public.admission_applicants WHERE applicant_id = 'ownership-new'",
    ),
  ).toBe("23514");
  expect(
    yield* attempt(
      pool,
      "UPDATE public.admission_applicants SET applicant_id = applicant_id WHERE applicant_id = 'ownership-original'",
    ),
  ).toBe("accepted");

  for (const assignment of [
    "applicant_id = 'ownership-new'",
    "admission_period_id = 'ownership-period-3'",
    "normalized_email = 'other@example.invalid'",
  ]) {
    expect(
      yield* attempt(
        pool,
        `UPDATE public.admission_applications SET ${assignment}
      WHERE application_id = 'ownership-application-1'`,
      ),
    ).toBe("23514");
  }
  // The authenticated returning rule still reuses its linked applicant for a new period.

  expect(
    yield* attempt(
      pool,
      insertApplication("ownership-returning", "ownership-original", "ownership-period-3"),
    ),
  ).toBe("accepted");
  expect(
    yield* attempt(
      pool,
      "UPDATE public.admission_applications SET year_of_study = 4 WHERE application_id = 'ownership-application-2'",
    ),
  ).toBe("accepted");
  // A real account-link insert still executes the existing no-op applicant version fence.
  expect(
    yield* attempt(
      pool,
      `WITH application AS (
      ${insertApplication("ownership-claim-application", "ownership-new", "ownership-period-3")}
      RETURNING application_id, applicant_id
    ), invitation AS (
      INSERT INTO public.applicant_account_invitations
        (invitation_id, application_id, applicant_id, token_digest, expires_at, state, issued_by, issued_at)
      SELECT 'ownership-new-invitation', application_id, applicant_id, repeat('f', 64),
        '2032-02-03'::timestamptz, 'Claimed', 'ownership-person', '2032-02-02'::timestamptz
      FROM application RETURNING invitation_id, applicant_id
    )
    INSERT INTO public.applicant_account_links (applicant_id, person_id, linked_at, invitation_id)
    SELECT applicant_id, 'ownership-person', '2032-02-02'::timestamptz, invitation_id FROM invitation`,
    ),
  ).toBe("accepted");
  yield* pool.unsafe("DROP FUNCTION public.ownership_attempt(text)");
  // Remove only the intentionally added control statement from this exact preservation comparison.
  const after = yield* snapshot(pool);
  expect(after.applicants).toHaveLength(2);
  expect({
    ...after,
    applicants: after.applicants.filter((row) =>
      Schema.is(Schema.Struct({ applicant_id: Schema.Literal("ownership-original") }))(row),
    ),
  }).toEqual(historical);
});

layer(Layer.merge(cluster, TestPlatform), { excludeTestServices: true, timeout: "180 seconds" })(
  "application statement ownership upgrade",
  (it) => {
    for (const predecessor of [82, 83] as const) {
      it.effect(
        `preserves rows and enforces ownership when upgrading from ${predecessor}, on PostgreSQL`,
        () =>
          Effect.gen(function* () {
            const postgres = yield* OwnershipUpgradeCluster;

            const url = yield* Effect.promise(() =>
              postgres.createDatabase(`ownership_upgrade_${predecessor}`),
            );

            const pool = yield* postgresTestClient({
              url: Redacted.make(url),
              maxConnections: 1,
              startupOptions: NativeDatabaseStartupOptions,
            });

            const baseline = selectDatabaseMigration("82_admission-outcome-mail");

            for (const migration of [...baseline.preceding, baseline.migration])
              yield* pool.withTransaction(
                executePostgresMigration(yield* readSql(migration)).pipe(
                  Effect.provideService(SqlClient.SqlClient, pool),
                ),
              );
            yield* proveUpgrade(pool, predecessor);
          }).pipe(Effect.scoped),
        120_000,
      );
    }
  },
);

// The PGlite cases create their database inside each test, so no disposable cluster is started.
layer(TestPlatform, { excludeTestServices: true, timeout: "180 seconds" })(
  "application statement ownership upgrade on PGlite",
  (it) => {
    for (const predecessor of [82, 83] as const) {
      it.effect(
        `preserves rows and enforces ownership when upgrading from ${predecessor}, on PGlite`,
        () => {
          const baseline = selectDatabaseMigration("82_admission-outcome-mail");

          return withPostgresTestDatabase(
            (pool) => proveUpgrade(pool, predecessor),
            [...baseline.preceding, baseline.migration],
          );
        },
        120_000,
      );
    }
  },
);
