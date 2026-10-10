/**
 * EX-0021: required public native SQL APIs in exact stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { PersonId } from "@vektorprogrammet/domain/organization";
/** 0106 owned synthetic PostgreSQL Person reconciliation journey. */
import assert from "node:assert/strict";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { Schema, flow, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import * as BunServices from "@effect/platform-bun/BunServices";
import { type DisposablePostgres, startDisposablePostgres } from "@monoweb/postgres";
import { Database } from "@vektorprogrammet/database";
import { DatabaseLive } from "../src/layers.js";
import { NativeDatabaseStartupOptions } from "../src/search-path.js";
import { executePostgresMigration } from "../src/postgres-migration-statements.js";
import { SqlClient } from "effect/sql";
import {
  PersonMapping,
  PersonCohortFailure,
  importPersonCohort as importPersonCohortEffect,
  PersonCohortReport,
} from "../src/person-cohort.js";
import {
  assertNoAmbientConfiguration,
  commandOutput,
  rehearsalWorkspace,
  removeWorkspace,
  writePrivateFile,
} from "./rehearsal-platform.js";

const makeRuntime = (url: string) =>
  ManagedRuntime.make(
    DatabaseLive({
      url: Redacted.make(url),
      maxConnections: 4,
      startupOptions: NativeDatabaseStartupOptions,
    }).pipe(Layer.provide(BunServices.layer)),
  );

const digest = flow(canonicalJsonBytes, sha256Hex);

const decodeJourneyRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Record(Schema.String, Schema.Json)),
);

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(PersonCohortReport));

const decodeRevision = Schema.decodeUnknownEffect(Schema.String);

assertNoAmbientConfiguration(["PERSON_COHORT_PG_URL", "PERSON_COHORT_INPUT", "DATABASE_URL"]);

const workspace = await rehearsalWorkspace("vektor-person-cohort-0106-");

const inputFile = workspace.file("person-cohort.json");

let postgres: DisposablePostgres | undefined;

let runtime: ReturnType<typeof makeRuntime> | undefined;

let evidence: Record<string, Schema.Json> | undefined;

try {
  postgres = await startDisposablePostgres({ database: "person_cohort_rehearsal" });

  const databaseUrl = postgres.url;
  runtime = makeRuntime(databaseUrl);
  const sql = await runtime.runPromise(Database);
  await runtime.runPromise(sql.health);

  await runtime.runPromise(
    sql.withTransaction(
      executePostgresMigration(`
    INSERT INTO public.person_profiles (person_id, first_name, last_name, revision)
    VALUES
      ('person-link', 'Native', 'Linked', 2),
      ('person-stale', 'Native', 'Stale', 1),
      ('person-email-mismatch', 'Native', 'Mismatch', 0),
      ('person-target-conflict', 'Native', 'Conflict', 0),
      ('person-email-owner', 'Native', 'Owner', 0);
    INSERT INTO public.person_contact_profiles (person_id, email, phone, revision)
    VALUES
      ('person-link', 'link@example.invalid', '+47 900 00 001', 3),
      ('person-stale', 'stale@example.invalid', '+47 900 00 002', 1),
      ('person-email-mismatch', 'native@example.invalid', '+47 900 00 003', 0),
      ('person-target-conflict', 'target@example.invalid', '+47 900 00 004', 0),
      ('person-email-owner', 'owned@example.invalid', '+47 900 00 005', 0)
  `).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    ),
  );

  const linkedBefore = (
    await runtime.runPromise(
      sql
        .unsafe(`SELECT p.*, c.email, c.phone, c.revision AS contact_revision
       FROM public.person_profiles p
       JOIN public.person_contact_profiles c USING (person_id)
      WHERE p.person_id = 'person-link'`)
        .pipe(Effect.flatMap(decodeJourneyRows)),
    )
  )[0];

  assert.ok(linkedBefore, "linked Person fixture must exist");

  type SourceRow = {
    sourceUserId: string;
    active: boolean;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    username?: string;
    companyEmail?: string;
  };

  const occurrences: Array<{ occurrenceId: string; row: unknown }> = [];
  const mappings: PersonMapping[] = [];

  const row = (sourceUserId: string, overrides: Partial<SourceRow> = {}): SourceRow => ({
    sourceUserId,
    active: true,
    firstName: "Legacy",
    lastName: sourceUserId,
    email: `${sourceUserId}@example.invalid`,
    phone: "+47 999 00 000",
    username: `legacy-${sourceUserId}`,
    companyEmail: `${sourceUserId}@vektorprogrammet.invalid`,
    ...overrides,
  });

  const attest = (source: SourceRow) => ({
    email: source.email,
    attestedBy: "synthetic-operator",
    evidenceRef: `attestation-${source.sourceUserId}`,
  });

  const addCreate = (
    sourceUserId: string,
    overrides: Partial<SourceRow> = {},
    personId = `person-${sourceUserId}`,
  ): SourceRow => {
    const source = row(sourceUserId, overrides);
    occurrences.push({ occurrenceId: `occ-${sourceUserId}`, row: source });
    mappings.push(
      PersonMapping.cases.CreatePerson.make({
        sourceUserId,
        personId: PersonId.make(personId),
        emailOwnership: attest(source),
      }),
    );

    return source;
  };

  const addLink = (
    sourceUserId: string,
    personId: string,
    expectedNameRevision: number,
    expectedContactRevision: number,
    overrides: Partial<SourceRow> = {},
  ): SourceRow => {
    const source = row(sourceUserId, overrides);
    occurrences.push({ occurrenceId: `occ-${sourceUserId}`, row: source });
    mappings.push(
      PersonMapping.cases.LinkExistingPerson.make({
        sourceUserId,
        personId: PersonId.make(personId),
        expectedNameRevision,
        expectedContactRevision,
        emailOwnership: attest(source),
      }),
    );

    return source;
  };

  addCreate("create");
  addLink("link", "person-link", 2, 3, { email: "link@example.invalid" });
  occurrences.push({ occurrenceId: "occ-invalid", row: { sourceUserId: "invalid" } });
  addCreate("inactive", { active: false });
  occurrences.push({ occurrenceId: "occ-no-map", row: row("no-map") });
  addCreate("ambiguous");
  mappings.push({ ...mappings.at(-1)! });
  addCreate("unattested");
  const unattested = mappings.at(-1)!;
  mappings[mappings.length - 1] = {
    ...unattested,
    emailOwnership: { ...unattested.emailOwnership, email: "other@example.invalid" },
  };
  const duplicateSource = addCreate("duplicate-source");
  occurrences.push({ occurrenceId: "occ-duplicate-source-second", row: { ...duplicateSource } });
  addCreate("duplicate-email-a", { email: "shared@example.invalid" });
  addCreate("duplicate-email-b", { email: "SHARED@example.invalid" });
  addCreate("duplicate-target-a");
  addCreate("duplicate-target-b", {}, "person-duplicate-target-a");
  addCreate("target-conflict", {}, "person-target-conflict");
  addCreate("email-conflict", { email: "owned@example.invalid" });
  addLink("missing", "person-missing", 0, 0);
  addLink("stale", "person-stale", 0, 0, { email: "stale@example.invalid" });
  addLink("email-mismatch", "person-email-mismatch", 0, 0);

  const snapshot = {
    sourceRepository: "synthetic-legacy",
    sourceRevision: "synthetic-source-0106",
    snapshotId: "person-cohort-0106",
    transformationRevision: "0106-v1",
    sourceKind: "Synthetic" as const,
    occurrences,
    mappings,
  };

  await writePrivateFile(inputFile, JSON.stringify(snapshot));

  const runCli = (runtime: ReturnType<typeof makeRuntime>) =>
    commandOutput(
      process.execPath,
      ["run", "packages/database/runtime/person-cohort-main.ts"],
      workspace.root,
      {
        PERSON_COHORT_MODE: "synthetic",
        NATIVE_IDENTITY_DEPLOYMENT: "local",
        PERSON_COHORT_PG_URL: databaseUrl,
        PERSON_COHORT_INPUT: inputFile,
      },
    ).then(flow(decodeReport, runtime.runPromise));

  const cliReport = await runCli(runtime);
  assert.equal(cliReport.replay, false);
  const report = await runtime.runPromise(importPersonCohortEffect(sql, snapshot));
  assert.equal(report.replay, true);
  assert.deepEqual(report.occurrences, cliReport.occurrences);
  assert.equal(report.input, occurrences.length);
  assert.equal(report.accepted, 2);
  assert.equal(report.quarantined, occurrences.length - 2);
  assert.equal(report.aliases, "LegacyUsernameAndCompanyEmailUnsupported");
  assert.equal(report.credentials, "HandledByCredentialCohort");
  assert.deepEqual(await runCli(runtime), report, "exact CLI replay is byte-equivalent");
  const concurrentRow = row("concurrent-initial");

  const concurrentSnapshot = {
    ...snapshot,
    sourceRevision: "synthetic-source-0106-concurrent",
    snapshotId: "person-cohort-0106-concurrent",
    occurrences: [{ occurrenceId: "occ-concurrent-initial", row: concurrentRow }],
    mappings: [
      PersonMapping.cases.CreatePerson.make({
        sourceUserId: "concurrent-initial",
        personId: PersonId.make("person-concurrent-initial"),
        emailOwnership: attest(concurrentRow),
      }),
    ],
  };

  const concurrent = await Promise.all([
    runtime.runPromise(importPersonCohortEffect(sql, concurrentSnapshot)),
    runtime.runPromise(importPersonCohortEffect(sql, concurrentSnapshot)),
  ]);

  assert.deepEqual(
    concurrent.map(({ replay }) => replay).sort((left, right) => Number(left) - Number(right)),
    [false, true],
  );
  assert.deepEqual(concurrent[0]!.occurrences, concurrent[1]!.occurrences);
  assert.equal(concurrent[0]!.accepted, 1);

  const concurrentCounts = (
    await runtime.runPromise(
      sql
        .unsafe(`SELECT
      (SELECT count(*)::text FROM public.person_profiles WHERE person_id = 'person-concurrent-initial') AS profile_count,
      (SELECT count(*)::text FROM public.person_contact_profiles WHERE person_id = 'person-concurrent-initial') AS contact_count,
      (SELECT count(*)::text FROM public.person_cohort_snapshots WHERE snapshot_id = 'person-cohort-0106-concurrent') AS snapshot_count,
      (SELECT count(*)::text FROM public.person_cohort_occurrences WHERE occurrence_id = 'occ-concurrent-initial') AS occurrence_count,
      (SELECT count(*)::text FROM public.person_cohort_imports WHERE source_user_id = 'concurrent-initial') AS import_count`)
        .pipe(Effect.flatMap(decodeJourneyRows)),
    )
  )[0];

  assert.ok(concurrentCounts);
  assert.deepEqual(Object.values(concurrentCounts).map(Number), [1, 1, 1, 1, 1]);

  const created = (
    await runtime.runPromise(
      sql
        .unsafe(`SELECT p.first_name, p.last_name, p.revision, c.email, c.phone,
            c.revision AS contact_revision
       FROM public.person_profiles p
       JOIN public.person_contact_profiles c USING (person_id)
      WHERE p.person_id = 'person-create'`)
        .pipe(Effect.flatMap(decodeJourneyRows)),
    )
  )[0];

  assert.ok(created, "accepted Person must have profile and contact facts");

  assert.deepEqual(created, {
    first_name: "Legacy",
    last_name: "create",
    revision: 0,
    email: "create@example.invalid",
    phone: "+47 999 00 000",
    contact_revision: 0,
  });

  const linkedAfter = (
    await runtime.runPromise(
      sql
        .unsafe(`SELECT p.*, c.email, c.phone, c.revision AS contact_revision
       FROM public.person_profiles p
       JOIN public.person_contact_profiles c USING (person_id)
      WHERE p.person_id = 'person-link'`)
        .pipe(Effect.flatMap(decodeJourneyRows)),
    )
  )[0];

  assert.deepEqual(linkedAfter, linkedBefore, "linking preserves native profile and contact facts");
  assert.equal(
    Number(
      (
        await runtime.runPromise(
          sql
            .unsafe(`SELECT count(*)::text FROM auth."user"`)
            .pipe(Effect.flatMap(decodeJourneyRows)),
        )
      )[0]!.count,
    ),
    0,
    "person reconciliation creates no credentials",
  );
  assert.deepEqual(
    (
      await runtime.runPromise(
        sql
          .unsafe(`SELECT reason FROM public.person_cohort_occurrences ORDER BY reason`)
          .pipe(Effect.flatMap(decodeJourneyRows)),
      )
    ).map(({ reason }) => reason),
    [
      "CreatedPerson",
      "CreatedPerson",
      "DuplicateEmail",
      "DuplicateEmail",
      "DuplicateSource",
      "DuplicateSource",
      "DuplicateTarget",
      "DuplicateTarget",
      "EmailConflict",
      "EmailUnattested",
      "ExistingEmailConflict",
      "ExistingPersonStale",
      "InvalidRow",
      "Inactive",
      "LinkedExistingPerson",
      "MappingAmbiguous",
      "MappingMissing",
      "PersonMissing",
      "TargetConflict",
    ].sort(),
  );

  const factsBeforeConflict = digest(
    (
      await runtime.runPromise(
        sql
          .unsafe(`SELECT jsonb_build_object(
        'profiles', (SELECT jsonb_agg(p ORDER BY person_id) FROM public.person_profiles p),
        'contacts', (SELECT jsonb_agg(c ORDER BY person_id) FROM public.person_contact_profiles c),
        'snapshots', (SELECT jsonb_agg(s ORDER BY snapshot_key) FROM public.person_cohort_snapshots s),
        'occurrences', (SELECT jsonb_agg(o ORDER BY snapshot_key, occurrence_id) FROM public.person_cohort_occurrences o),
        'imports', (SELECT jsonb_agg(i ORDER BY source_repository, source_user_id) FROM public.person_cohort_imports i)
      ) AS facts`)
          .pipe(Effect.flatMap(decodeJourneyRows)),
      )
    )[0],
  );

  await assert.rejects(
    runtime.runPromise(
      importPersonCohortEffect(sql, { ...snapshot, sourceRevision: "changed-source" }),
    ),
    (cause) => cause instanceof PersonCohortFailure && cause.code === "SnapshotConflict",
  );
  assert.equal(
    digest(
      (
        await runtime.runPromise(
          sql
            .unsafe(`SELECT jsonb_build_object(
          'profiles', (SELECT jsonb_agg(p ORDER BY person_id) FROM public.person_profiles p),
          'contacts', (SELECT jsonb_agg(c ORDER BY person_id) FROM public.person_contact_profiles c),
          'snapshots', (SELECT jsonb_agg(s ORDER BY snapshot_key) FROM public.person_cohort_snapshots s),
          'occurrences', (SELECT jsonb_agg(o ORDER BY snapshot_key, occurrence_id) FROM public.person_cohort_occurrences o),
          'imports', (SELECT jsonb_agg(i ORDER BY source_repository, source_user_id) FROM public.person_cohort_imports i)
        ) AS facts`)
            .pipe(Effect.flatMap(decodeJourneyRows)),
        )
      )[0],
    ),
    factsBeforeConflict,
  );

  const crossTargetRow = row("cross-target", { email: "link@example.invalid" });

  const crossTargetReport = await runtime.runPromise(
    importPersonCohortEffect(sql, {
      ...snapshot,
      snapshotId: "person-cohort-0106-cross-target",
      occurrences: [{ occurrenceId: "occ-cross-target", row: crossTargetRow }],
      mappings: [
        PersonMapping.cases.LinkExistingPerson.make({
          sourceUserId: "cross-target",
          personId: PersonId.make("person-link"),
          emailOwnership: attest(crossTargetRow),
          expectedNameRevision: 2,
          expectedContactRevision: 3,
        }),
      ],
    }),
  );

  assert.deepEqual(crossTargetReport.occurrences, [
    {
      occurrenceId: "occ-cross-target",
      disposition: "Quarantined",
      reason: "TargetConflict",
    },
  ]);

  await runtime.runPromise(
    sql.withTransaction(
      executePostgresMigration(`
    CREATE FUNCTION public.fail_person_cohort_import() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER fail_person_cohort_import
    BEFORE INSERT ON public.person_cohort_imports
    FOR EACH ROW EXECUTE FUNCTION public.fail_person_cohort_import()
  `).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    ),
  );
  const rollbackRow = row("rollback");

  const rollbackSnapshot = {
    ...snapshot,
    snapshotId: "person-cohort-0106-rollback",
    occurrences: [{ occurrenceId: "occ-rollback", row: rollbackRow }],
    mappings: [
      PersonMapping.cases.CreatePerson.make({
        sourceUserId: "rollback",
        personId: PersonId.make("person-rollback"),
        emailOwnership: attest(rollbackRow),
      }),
    ],
  };

  await assert.rejects(
    runtime.runPromise(importPersonCohortEffect(sql, rollbackSnapshot)),
    (cause) => cause instanceof PersonCohortFailure && cause.code === "PersistenceFailure",
  );
  assert.equal(
    Number(
      (
        await runtime.runPromise(
          sql
            .unsafe(
              `SELECT count(*)::text FROM public.person_profiles WHERE person_id = 'person-rollback'`,
            )
            .pipe(Effect.flatMap(decodeJourneyRows)),
        )
      )[0]!.count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await runtime.runPromise(
          sql
            .unsafe(
              `SELECT count(*)::text FROM public.person_cohort_snapshots WHERE snapshot_id = 'person-cohort-0106-rollback'`,
            )
            .pipe(Effect.flatMap(decodeJourneyRows)),
        )
      )[0]!.count,
    ),
    0,
  );
  await runtime.runPromise(
    sql.withTransaction(
      executePostgresMigration(`
    DROP TRIGGER fail_person_cohort_import ON public.person_cohort_imports;
    DROP FUNCTION public.fail_person_cohort_import()
  `).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    ),
  );
  await assert.rejects(
    runtime.runPromise(
      sql
        .unsafe(`UPDATE public.person_cohort_imports SET evidence_ref = 'changed'`)
        .pipe(Effect.flatMap(decodeJourneyRows)),
    ),
    /Person cohort evidence is immutable/,
  );

  evidence = {
    contract: "0106",
    sourceRevision: (
      await runtime.runPromise(
        decodeRevision(await commandOutput("git", ["rev-parse", "HEAD"], workspace.root)),
      )
    ).trim(),
    report,
    createdPerson: created,
    linkedPersonUnchanged: true,
    concurrentInitialImport: true,
    changedSnapshotRejected: true,
    crossSnapshotTargetConflict: true,
    forcedRollback: true,
    immutableEvidence: true,
    productionEffects: "none",
  };
} finally {
  try {
    if (runtime) await runtime.dispose();
  } finally {
    try {
      await postgres?.stop();
    } finally {
      await removeWorkspace(workspace.artifacts);
    }
  }
}

assert.ok(evidence, "rehearsal must complete before evidence is emitted");

process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
