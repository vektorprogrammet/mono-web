/**
 * EX-0021: required public native APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import {
  canonicalJsonBytes,
  canonicalJsonValue,
  sha256Hex,
} from "@vektorprogrammet/domain/shared-kernel";
/** 0108 owned synthetic PostgreSQL historical assistant service journey. */
import assert from "node:assert/strict";
import { Schema, flow, Effect, FileSystem, Redacted, Context, Layer, Scope, Exit } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { SqlClient } from "effect/sql";
import { Database } from "../src/service.js";
import { executePostgresMigration } from "../src/postgres-migration-statements.js";
import {
  type DisposablePostgres,
  postgresProgram,
  startDisposablePostgres,
} from "@monoweb/postgres";
import { databaseHealth } from "@vektorprogrammet/database";
import {
  HistoricalServiceFailure,
  importHistoricalServiceCohort as importHistoricalServiceCohortEffect,
} from "../src/historical-service-cohort.js";
import { DatabaseLive } from "../src/layers.js";
import { NativeDatabaseStartupOptions } from "../src/search-path.js";
import { importPersonCohort as importPersonCohortEffect } from "../src/person-cohort.js";

import {
  assertNoAmbientConfiguration,
  commandOutput,
  rehearsalWorkspace,
  removeWorkspace,
  runOnBun,
  writePrivateFile,
} from "./rehearsal-platform.js";

const importPersonCohort = flow(importPersonCohortEffect, Effect.runPromise);

const importHistoricalServiceCohort = flow(importHistoricalServiceCohortEffect, Effect.runPromise);

const digest = flow(canonicalJsonBytes, sha256Hex);

const decodeCliReport = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const decodeJsonFacts = Schema.decodeUnknownEffect(Schema.Struct({ facts: Schema.Json }));

const decodeSchoolRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ school_id: Schema.FiniteFromString, name: Schema.String })),
);

/** A `count(*)` is one `int8` row; the native client decodes `int8` to `bigint`. */
const decodeCountRows = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ count: Schema.BigInt })]),
);

const decodeReasonRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ reason: Schema.String })),
);

assertNoAmbientConfiguration([
  "HISTORICAL_SERVICE_PG_URL",
  "HISTORICAL_SERVICE_INPUT",
  "DATABASE_URL",
]);

const workspace = await rehearsalWorkspace("vektor-historical-service-0108-");

const inputFile = workspace.file("historical-service.json");

const backup = workspace.file("historical-service.dump");

let postgres: DisposablePostgres | undefined;

let databaseScope: Scope.Closeable | undefined;

let evidence: Record<string, Schema.Json> | undefined;

try {
  postgres = await startDisposablePostgres({ database: "historical_service_rehearsal" });

  const databaseUrl = postgres.url;
  databaseScope = await Effect.runPromise(Scope.make());

  const databaseContext = await Effect.runPromise(
    Layer.buildWithScope(
      DatabaseLive({
        url: Redacted.make(databaseUrl),
        maxConnections: 4,
        startupOptions: NativeDatabaseStartupOptions,
      }).pipe(Layer.provide(BunServices.layer)),
      databaseScope,
    ),
  );

  const pool = Context.get(databaseContext, Database);

  await Effect.runPromise(databaseHealth.pipe(Effect.provideContext(databaseContext)));

  await Effect.runPromise(
    executePostgresMigration(`
    INSERT INTO public.organization_departments
      (department_id, name, short_name, email, city)
    VALUES
      ('department-a', 'Department A', 'A', 'a@example.invalid', 'Trondheim'),
      ('department-b', 'Department B', 'B', 'b@example.invalid', 'Trondheim');
    INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at)
    VALUES ('semester-2026-autumn', '2026-08-01T00:00:00Z', '2026-12-31T00:00:00Z');
    INSERT INTO public.schools_directory_schools
      (name, contact_person, email, phone, language, active)
    VALUES
      ('School A', 'Contact A', 'school-a@example.invalid', '+47 900 10 001', 'Norwegian', true),
      ('School B', 'Contact B', 'school-b@example.invalid', '+47 900 10 002', 'Norwegian', true);
    INSERT INTO public.schools_directory_departments (school_id, department_id)
    SELECT school_id, 'department-a' FROM public.schools_directory_schools;
    INSERT INTO public.person_profiles (person_id, first_name, last_name)
    VALUES
      ('person-valid-link', 'Existing', 'Volunteer'),
      ('person-missing-evidence', 'Unreconciled', 'Volunteer');
    INSERT INTO public.person_contact_profiles (person_id, email, phone)
    VALUES
      ('person-valid-link', 'valid-link@example.invalid', '+47 900 20 001'),
      ('person-missing-evidence', 'missing-evidence@example.invalid', '+47 900 20 002')
  `).pipe(Effect.provideService(SqlClient.SqlClient, pool)),
  );

  const schools = await Effect.runPromise(
    pool
      .unsafe(
        `SELECT school_id::text, name FROM public.schools_directory_schools ORDER BY school_id`,
      )
      .pipe(Effect.flatMap(decodeSchoolRows)),
  );

  const schoolId = (name: string) => {
    const school = schools.find((candidate) => candidate.name === name);
    assert.ok(school, `${name} must be seeded`);

    return school.school_id;
  };

  const schoolA = schoolId("School A");

  const schoolB = schoolId("School B");

  const countRows = (statement: string) =>
    Effect.runPromise(
      pool.unsafe(statement).pipe(
        Effect.flatMap(decodeCountRows),
        Effect.map(([{ count }]) => count),
      ),
    );

  const reconciledSources = [
    "valid-link",
    "valid-both",
    "missing-reference",
    "school-mismatch",
    "duplicate-source",
    "duplicate-target",
    "source-mismatch",
    "concurrent",
    "rollback",
  ];

  const personOccurrences = reconciledSources.map((sourceUserId) => ({
    occurrenceId: `person-${sourceUserId}`,
    row: {
      sourceUserId,
      active: true,
      firstName: "Synthetic",
      lastName: sourceUserId,
      email: `${sourceUserId}@example.invalid`,
      phone: "+47 999 00 000",
    },
  }));

  const personMappings = reconciledSources.map((sourceUserId) =>
    sourceUserId === "valid-link"
      ? {
          _tag: "LinkExistingPerson" as const,
          sourceUserId,
          personId: "person-valid-link",
          emailOwnership: {
            email: "valid-link@example.invalid",
            attestedBy: "synthetic-operator",
            evidenceRef: "person-valid-link",
          },
          expectedNameRevision: 0,
          expectedContactRevision: 0,
        }
      : {
          _tag: "CreatePerson" as const,
          sourceUserId,
          personId: `person-${sourceUserId}`,
          emailOwnership: {
            email: `${sourceUserId}@example.invalid`,
            attestedBy: "synthetic-operator",
            evidenceRef: `person-${sourceUserId}`,
          },
        },
  );

  const personReport = await importPersonCohort(pool, {
    sourceRepository: "synthetic-legacy",
    sourceRevision: "synthetic-person-source-0108",
    snapshotId: "person-cohort-0108",
    transformationRevision: "0106-v1",
    sourceKind: "Synthetic" as const,
    occurrences: personOccurrences,
    mappings: personMappings,
  });

  assert.equal(personReport.accepted, reconciledSources.length);

  type SourceRow = {
    sourceHistoryId: string;
    sourceUserId: string;
    sourceDepartmentId: string;
    sourceSemesterId: string;
    sourceSchoolId: string;
    workdays: string;
    block: "Bolk 1" | "Bolk 2" | "Bolk 1, Bolk 2";
    day: "Mandag" | "Tirsdag" | "Onsdag" | "Torsdag" | "Fredag";
  };

  type Mapping = {
    sourceHistoryId: string;
    sourceUserId: string;
    sourceDepartmentId: string;
    sourceSemesterId: string;
    sourceSchoolId: string;
    personId: string;
    departmentId: string;
    semesterId: string;
    schoolId: number;
    evidenceRef: string;
  };

  const occurrences: Array<{ occurrenceId: string; row: unknown }> = [];

  const mappings: Mapping[] = [];

  const row = (
    sourceHistoryId: string,
    sourceUserId: string,
    overrides: Partial<SourceRow> = {},
  ): SourceRow => ({
    sourceHistoryId,
    sourceUserId,
    sourceDepartmentId: "legacy-department-a",
    sourceSemesterId: "legacy-semester-2026-autumn",
    sourceSchoolId: "legacy-school-a",
    workdays: "4",
    block: "Bolk 1",
    day: "Mandag",
    ...overrides,
  });

  const mapping = (
    source: SourceRow,
    personId: string,
    overrides: Partial<Mapping> = {},
  ): Mapping => ({
    sourceHistoryId: source.sourceHistoryId,
    sourceUserId: source.sourceUserId,
    sourceDepartmentId: source.sourceDepartmentId,
    sourceSemesterId: source.sourceSemesterId,
    sourceSchoolId: source.sourceSchoolId,
    personId,
    departmentId: "department-a",
    semesterId: "semester-2026-autumn",
    schoolId: schoolA,
    evidenceRef: `history-${source.sourceHistoryId}`,
    ...overrides,
  });

  const add = (
    sourceHistoryId: string,
    sourceUserId: string,
    personId: string,
    rowOverrides: Partial<SourceRow> = {},
    mappingOverrides: Partial<Mapping> = {},
  ) => {
    const source = row(sourceHistoryId, sourceUserId, rowOverrides);
    occurrences.push({ occurrenceId: `occ-${sourceHistoryId}`, row: source });
    mappings.push(mapping(source, personId, mappingOverrides));

    return source;
  };

  const acceptedSource = add("valid-link", "valid-link", "person-valid-link");
  add(
    "valid-both",
    "valid-both",
    "person-valid-both",
    { block: "Bolk 1, Bolk 2", day: "Fredag", workdays: "8", sourceSchoolId: "legacy-school-b" },
    { schoolId: schoolB },
  );
  occurrences.push({ occurrenceId: "occ-invalid", row: { sourceHistoryId: "invalid" } });
  occurrences.push({ occurrenceId: "occ-no-mapping", row: row("no-mapping", "valid-link") });

  const ambiguous = add("ambiguous", "valid-link", "person-valid-link", { block: "Bolk 2" });
  mappings.push(mapping(ambiguous, "person-valid-link"));
  add("missing-person-evidence", "missing-evidence", "person-missing-evidence", {
    block: "Bolk 2",
  });
  add(
    "missing-reference",
    "missing-reference",
    "person-missing-reference",
    { block: "Bolk 2" },
    { departmentId: "department-missing" },
  );
  add(
    "school-mismatch",
    "school-mismatch",
    "person-school-mismatch",
    { block: "Bolk 2" },
    { departmentId: "department-b" },
  );

  const duplicateSource = add("duplicate-source", "duplicate-source", "person-duplicate-source", {
    block: "Bolk 2",
  });

  occurrences.push({ occurrenceId: "occ-duplicate-source-second", row: { ...duplicateSource } });
  add("duplicate-target-a", "duplicate-target", "person-duplicate-target", { block: "Bolk 2" });
  add("duplicate-target-b", "duplicate-target", "person-duplicate-target", { block: "Bolk 2" });

  const sourceMismatch = row("source-mismatch", "source-mismatch", { block: "Bolk 2" });
  occurrences.push({ occurrenceId: "occ-source-mismatch", row: sourceMismatch });
  mappings.push(
    mapping(sourceMismatch, "person-source-mismatch", { sourceSchoolId: "wrong-school" }),
  );

  const snapshot = {
    sourceRepository: "synthetic-legacy",
    sourceRevision: "synthetic-history-source-0108",
    snapshotId: "historical-service-0108",
    transformationRevision: "0108-v1",
    sourceKind: "Synthetic" as const,
    occurrences,
    mappings,
  };

  await writePrivateFile(inputFile, JSON.stringify(snapshot));

  const currentState = () =>
    Effect.runPromise(
      pool
        .unsafe(`SELECT jsonb_build_object(
        'affiliations', (SELECT jsonb_agg(a ORDER BY person_id, department_id) FROM public.organization_volunteer_affiliations a),
        'placements', (SELECT jsonb_agg(p ORDER BY placement_id) FROM public.assistant_placements p),
        'demand', (SELECT jsonb_agg(d ORDER BY department_id, semester_id, school_id, day, block) FROM public.school_service_demand d),
        'absences', (SELECT jsonb_agg(a ORDER BY absence_id) FROM public.school_service_absences a),
        'occurrences', (SELECT jsonb_agg(o ORDER BY occurrence_id) FROM public.school_service_occurrences o)
      ) AS facts`)
        .pipe(
          Effect.flatMap((rows) => decodeJsonFacts(rows[0])),
          Effect.map(({ facts }) => facts),
        ),
    );

  const currentBefore = digest(await currentState());

  const runCli = () =>
    commandOutput(
      process.execPath,
      ["run", "packages/database/runtime/historical-service-cohort-main.ts"],
      workspace.root,
      {
        HISTORICAL_SERVICE_MODE: "synthetic",
        NATIVE_IDENTITY_DEPLOYMENT: "local",
        HISTORICAL_SERVICE_PG_URL: databaseUrl,
        HISTORICAL_SERVICE_INPUT: inputFile,
      },
    ).then((text) => Effect.runPromise(decodeCliReport(text)));

  const cliReport = await runCli();

  const report = await importHistoricalServiceCohort(pool, snapshot);

  assert.deepEqual(cliReport, report);

  assert.equal(report.accepted, 2);

  assert.equal(report.quarantined, occurrences.length - 2);

  assert.equal(report.currentState, "Unchanged");

  assert.equal(report.historicalAffiliation, "DerivedFromAcceptedService");

  assert.deepEqual(await runCli(), report, "exact CLI replay is byte-equivalent");

  assert.equal(
    digest(await currentState()),
    currentBefore,
    "historical import changed current state",
  );

  assert.deepEqual(
    await Effect.runPromise(
      pool.unsafe(`SELECT source_history_id, person_id, day, workdays, block
         FROM public.assistant_service_history ORDER BY source_history_id`),
    ),
    [
      {
        source_history_id: "valid-both",
        person_id: "person-valid-both",
        day: "Friday",
        workdays: 8,
        block: "Both",
      },
      {
        source_history_id: "valid-link",
        person_id: "person-valid-link",
        day: "Monday",
        workdays: 4,
        block: "1",
      },
    ],
  );

  assert.equal(await countRows(`SELECT count(*) FROM public.assistant_affiliation_history`), 2n);

  assert.deepEqual(
    (
      await Effect.runPromise(
        pool
          .unsafe(`SELECT reason FROM public.historical_service_occurrences ORDER BY reason`)
          .pipe(Effect.flatMap(decodeReasonRows)),
      )
    ).map(({ reason }) => reason),
    [
      "DuplicateSource",
      "DuplicateSource",
      "DuplicateTarget",
      "DuplicateTarget",
      "Imported",
      "Imported",
      "InvalidRow",
      "MappingAmbiguous",
      "MappingMissing",
      "NativeReferenceMissing",
      "PersonReconciliationMissing",
      "SchoolDepartmentMismatch",
      "SourceReferenceMismatch",
    ].sort(),
  );

  const concurrentRow = row("concurrent", "concurrent", { block: "Bolk 2" });

  const concurrentSnapshot = {
    ...snapshot,
    sourceRevision: "synthetic-history-source-0108-concurrent",
    snapshotId: "historical-service-0108-concurrent",
    occurrences: [{ occurrenceId: "occ-concurrent", row: concurrentRow }],
    mappings: [mapping(concurrentRow, "person-concurrent")],
  };

  const concurrent = await Promise.all([
    importHistoricalServiceCohort(pool, concurrentSnapshot),
    importHistoricalServiceCohort(pool, concurrentSnapshot),
  ]);

  assert.deepEqual(concurrent[0], concurrent[1]);

  assert.equal(concurrent[0].accepted, 1);

  assert.equal(
    await countRows(
      `SELECT count(*) FROM public.assistant_service_history WHERE source_history_id = 'concurrent'`,
    ),
    1n,
  );

  const facts = (databasePool: SqlClient.SqlClient) =>
    Effect.runPromise(
      databasePool
        .unsafe(`SELECT jsonb_build_object(
        'snapshots', (SELECT jsonb_agg(s ORDER BY snapshot_key) FROM public.historical_service_snapshots s),
        'occurrences', (SELECT jsonb_agg(o ORDER BY snapshot_key, occurrence_id) FROM public.historical_service_occurrences o),
        'history', (SELECT jsonb_agg(h ORDER BY source_repository, source_history_id) FROM public.assistant_service_history h),
        'affiliations', (SELECT jsonb_agg(a ORDER BY person_id, department_id, semester_id) FROM public.assistant_affiliation_history a)
      ) AS facts`)
        .pipe(
          Effect.flatMap((rows) => decodeJsonFacts(rows[0])),
          Effect.map(({ facts }) => facts),
        ),
    );

  const factsBeforeConflict = digest(await facts(pool));

  await assert.rejects(
    importHistoricalServiceCohort(pool, { ...snapshot, sourceRevision: "changed-source" }),
    (cause) => cause instanceof HistoricalServiceFailure && cause.code === "SnapshotConflict",
  );

  const changedAcceptedRow = {
    ...acceptedSource,
    day: "Tirsdag" as const,
  };

  await assert.rejects(
    importHistoricalServiceCohort(pool, {
      ...snapshot,
      snapshotId: "historical-service-0108-changed-source",
      occurrences: [{ occurrenceId: "occ-valid-link-changed", row: changedAcceptedRow }],
      mappings: [mapping(changedAcceptedRow, "person-valid-link")],
    }),
    (cause) => cause instanceof HistoricalServiceFailure && cause.code === "SourceIdentityConflict",
  );

  assert.equal(digest(await facts(pool)), factsBeforeConflict, "conflicts changed persisted facts");

  const targetConflictRow = row("target-conflict", "valid-link");

  const targetConflict = await importHistoricalServiceCohort(pool, {
    ...snapshot,
    snapshotId: "historical-service-0108-target-conflict",
    occurrences: [{ occurrenceId: "occ-target-conflict", row: targetConflictRow }],
    mappings: [mapping(targetConflictRow, "person-valid-link")],
  });

  assert.deepEqual(targetConflict.occurrences, [
    { occurrenceId: "occ-target-conflict", disposition: "Quarantined", reason: "TargetConflict" },
  ]);

  await Effect.runPromise(
    executePostgresMigration(`
    CREATE FUNCTION public.fail_historical_service_import() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER fail_historical_service_import
    BEFORE INSERT ON public.assistant_service_history
    FOR EACH ROW EXECUTE FUNCTION public.fail_historical_service_import()
  `).pipe(Effect.provideService(SqlClient.SqlClient, pool)),
  );

  const rollbackRow = row("rollback", "rollback", { block: "Bolk 2" });

  await assert.rejects(
    importHistoricalServiceCohort(pool, {
      ...snapshot,
      snapshotId: "historical-service-0108-rollback",
      occurrences: [{ occurrenceId: "occ-rollback", row: rollbackRow }],
      mappings: [mapping(rollbackRow, "person-rollback")],
    }),
    (cause) => cause instanceof HistoricalServiceFailure && cause.code === "PersistenceFailure",
  );

  assert.equal(
    await countRows(
      `SELECT count(*) FROM public.historical_service_snapshots WHERE snapshot_id = 'historical-service-0108-rollback'`,
    ),
    0n,
  );

  await Effect.runPromise(
    executePostgresMigration(`
    DROP TRIGGER fail_historical_service_import ON public.assistant_service_history;
    DROP FUNCTION public.fail_historical_service_import()
  `).pipe(Effect.provideService(SqlClient.SqlClient, pool)),
  );

  await assert.rejects(
    Effect.runPromise(
      pool.unsafe(`UPDATE public.assistant_service_history SET evidence_ref = 'changed'`),
    ),
    /append-only/,
  );

  const restoredFactsExpected = await facts(pool);

  await commandOutput(
    postgresProgram("pg_dump"),
    ["--dbname", databaseUrl, "--format=custom", "--file", backup],
    workspace.root,
  );

  const [backupInfo, backupBytes] = await runOnBun(
    FileSystem.FileSystem.use((fs) => Effect.all([fs.stat(backup), fs.readFile(backup)])),
  );

  assert.ok(backupInfo.size > 0);

  const backupChecksum = sha256Hex(backupBytes);

  const restoredUrl = await postgres.createDatabase("historical_service_restored");

  await commandOutput(
    postgresProgram("pg_restore"),
    ["--dbname", restoredUrl, backup],
    workspace.root,
  );

  const restoredScope = await Effect.runPromise(Scope.make());

  try {
    const restoredContext = await Effect.runPromise(
      Layer.buildWithScope(
        DatabaseLive({
          url: Redacted.make(restoredUrl),
          maxConnections: 4,
          startupOptions: NativeDatabaseStartupOptions,
        }).pipe(Layer.provide(BunServices.layer)),
        restoredScope,
      ),
    );

    assert.deepEqual(await facts(Context.get(restoredContext, Database)), restoredFactsExpected);
  } finally {
    await Effect.runPromise(Scope.close(restoredScope, Exit.void));
  }

  evidence = {
    contract: "0108",
    sourceRevision: (await commandOutput("git", ["rev-parse", "HEAD"], workspace.root)).trim(),
    report: canonicalJsonValue(report),
    concurrentFirstImport: true,
    currentStateUnchanged: true,
    changedSnapshotRejected: true,
    changedAcceptedSourceRejected: true,
    crossSnapshotTargetConflict: true,
    forcedRollback: true,
    appendOnlyHistory: true,
    backup: { nonempty: true, restored: true, sha256: backupChecksum },
    compatibility: {
      legacyWeekdaysNormalized: true,
      legacyBlocksNormalized: true,
      existingPersonLinked: true,
      bothBlockPreserved: true,
    },
    productionEffects: "none",
  };
} finally {
  if (databaseScope) await Effect.runPromise(Scope.close(databaseScope, Exit.void));

  await postgres?.stop().catch(() => undefined);

  await removeWorkspace(workspace.artifacts);
}

assert.ok(evidence, "rehearsal must complete before evidence is emitted");

process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
