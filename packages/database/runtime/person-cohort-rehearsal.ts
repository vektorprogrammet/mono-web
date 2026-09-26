import { PersonId } from "@vektorprogrammet/domain/organization";
/** 0106 owned synthetic PostgreSQL Person reconciliation journey. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Schema, flow, Effect, Redacted } from "effect";
import { Pool } from "pg";
import { type DisposablePostgres, startDisposablePostgres } from "@monoweb/postgres";
import { databaseHealth } from "@vektorprogrammet/database";
import { DatabaseLive } from "../src/layers.js";
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
  runOnBun,
  writePrivateFile,
} from "./rehearsal-platform.js";

const importPersonCohort = flow(importPersonCohortEffect, Effect.runPromise);

const digest = flow(Schema.decodeUnknownSync(Schema.Json), (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex"),
);

assertNoAmbientConfiguration(["PERSON_COHORT_PG_URL", "PERSON_COHORT_INPUT", "DATABASE_URL"]);

const workspace = await rehearsalWorkspace("vektor-person-cohort-0106-");

const inputFile = workspace.file("person-cohort.json");

let postgres: DisposablePostgres | undefined;

let pool: Pool | undefined;

let evidence: Record<string, Schema.Json> | undefined;

try {
  postgres = await startDisposablePostgres({ database: "person_cohort_rehearsal" });

  const databaseUrl = postgres.url;
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await runOnBun(
    databaseHealth.pipe(
      Effect.provide(DatabaseLive({ url: Redacted.make(databaseUrl), maxConnections: 1 })),
    ),
  );

  await pool.query(`
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
  `);

  const linkedBefore = (
    await pool.query(
      `SELECT p.*, c.email, c.phone, c.revision AS contact_revision
         FROM public.person_profiles p
         JOIN public.person_contact_profiles c USING (person_id)
        WHERE p.person_id = 'person-link'`,
    )
  ).rows[0];

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

  const runCli = () =>
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
    ).then(Schema.decodeSync(Schema.fromJsonString(PersonCohortReport)));

  const cliReport = await runCli();
  assert.equal(cliReport.replay, false);
  const report = await importPersonCohort(pool, snapshot);
  assert.equal(report.replay, true);
  assert.deepEqual(report.occurrences, cliReport.occurrences);
  assert.equal(report.input, occurrences.length);
  assert.equal(report.accepted, 2);
  assert.equal(report.quarantined, occurrences.length - 2);
  assert.equal(report.aliases, "LegacyUsernameAndCompanyEmailUnsupported");
  assert.equal(report.credentials, "HandledByCredentialCohort");
  assert.deepEqual(await runCli(), report, "exact CLI replay is byte-equivalent");
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
    importPersonCohort(pool, concurrentSnapshot),
    importPersonCohort(pool, concurrentSnapshot),
  ]);

  assert.deepEqual(
    concurrent.map(({ replay }) => replay).sort((left, right) => Number(left) - Number(right)),
    [false, true],
  );
  assert.deepEqual(concurrent[0]!.occurrences, concurrent[1]!.occurrences);
  assert.equal(concurrent[0]!.accepted, 1);

  const concurrentCounts = (
    await pool.query<{
      profile_count: string;
      contact_count: string;
      snapshot_count: string;
      occurrence_count: string;
      import_count: string;
    }>(
      `SELECT
        (SELECT count(*) FROM public.person_profiles WHERE person_id = 'person-concurrent-initial') AS profile_count,
        (SELECT count(*) FROM public.person_contact_profiles WHERE person_id = 'person-concurrent-initial') AS contact_count,
        (SELECT count(*) FROM public.person_cohort_snapshots WHERE snapshot_id = 'person-cohort-0106-concurrent') AS snapshot_count,
        (SELECT count(*) FROM public.person_cohort_occurrences WHERE occurrence_id = 'occ-concurrent-initial') AS occurrence_count,
        (SELECT count(*) FROM public.person_cohort_imports WHERE source_user_id = 'concurrent-initial') AS import_count`,
    )
  ).rows[0];

  assert.ok(concurrentCounts);
  assert.deepEqual(Object.values(concurrentCounts).map(Number), [1, 1, 1, 1, 1]);

  const created = (
    await pool.query(
      `SELECT p.first_name, p.last_name, p.revision, c.email, c.phone,
              c.revision AS contact_revision
         FROM public.person_profiles p
         JOIN public.person_contact_profiles c USING (person_id)
        WHERE p.person_id = 'person-create'`,
    )
  ).rows[0];

  assert.deepEqual(created, {
    first_name: "Legacy",
    last_name: "create",
    revision: 0,
    email: "create@example.invalid",
    phone: "+47 999 00 000",
    contact_revision: 0,
  });

  const linkedAfter = (
    await pool.query(
      `SELECT p.*, c.email, c.phone, c.revision AS contact_revision
         FROM public.person_profiles p
         JOIN public.person_contact_profiles c USING (person_id)
        WHERE p.person_id = 'person-link'`,
    )
  ).rows[0];

  assert.deepEqual(linkedAfter, linkedBefore, "linking preserves native profile and contact facts");
  assert.equal(
    Number((await pool.query(`SELECT count(*) FROM auth."user"`)).rows[0].count),
    0,
    "person reconciliation creates no credentials",
  );
  assert.deepEqual(
    (
      await pool.query(`SELECT reason FROM public.person_cohort_occurrences ORDER BY reason`)
    ).rows.map(({ reason }) => reason),
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
      await pool.query(
        `SELECT jsonb_build_object(
          'profiles', (SELECT jsonb_agg(p ORDER BY person_id) FROM public.person_profiles p),
          'contacts', (SELECT jsonb_agg(c ORDER BY person_id) FROM public.person_contact_profiles c),
          'snapshots', (SELECT jsonb_agg(s ORDER BY snapshot_key) FROM public.person_cohort_snapshots s),
          'occurrences', (SELECT jsonb_agg(o ORDER BY snapshot_key, occurrence_id) FROM public.person_cohort_occurrences o),
          'imports', (SELECT jsonb_agg(i ORDER BY source_repository, source_user_id) FROM public.person_cohort_imports i)
        ) AS facts`,
      )
    ).rows[0],
  );

  await assert.rejects(
    importPersonCohort(pool, { ...snapshot, sourceRevision: "changed-source" }),
    (cause) => cause instanceof PersonCohortFailure && cause.code === "SnapshotConflict",
  );
  assert.equal(
    digest(
      (
        await pool.query(
          `SELECT jsonb_build_object(
            'profiles', (SELECT jsonb_agg(p ORDER BY person_id) FROM public.person_profiles p),
            'contacts', (SELECT jsonb_agg(c ORDER BY person_id) FROM public.person_contact_profiles c),
            'snapshots', (SELECT jsonb_agg(s ORDER BY snapshot_key) FROM public.person_cohort_snapshots s),
            'occurrences', (SELECT jsonb_agg(o ORDER BY snapshot_key, occurrence_id) FROM public.person_cohort_occurrences o),
            'imports', (SELECT jsonb_agg(i ORDER BY source_repository, source_user_id) FROM public.person_cohort_imports i)
          ) AS facts`,
        )
      ).rows[0],
    ),
    factsBeforeConflict,
  );

  const crossTargetRow = row("cross-target", { email: "link@example.invalid" });

  const crossTargetReport = await importPersonCohort(pool, {
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
  });

  assert.deepEqual(crossTargetReport.occurrences, [
    {
      occurrenceId: "occ-cross-target",
      disposition: "Quarantined",
      reason: "TargetConflict",
    },
  ]);

  await pool.query(`
    CREATE FUNCTION public.fail_person_cohort_import() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER fail_person_cohort_import
    BEFORE INSERT ON public.person_cohort_imports
    FOR EACH ROW EXECUTE FUNCTION public.fail_person_cohort_import()
  `);
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
    importPersonCohort(pool, rollbackSnapshot),
    (cause) => cause instanceof PersonCohortFailure && cause.code === "PersistenceFailure",
  );
  assert.equal(
    Number(
      (
        await pool.query(
          `SELECT count(*) FROM public.person_profiles WHERE person_id = 'person-rollback'`,
        )
      ).rows[0].count,
    ),
    0,
  );
  assert.equal(
    Number(
      (
        await pool.query(
          `SELECT count(*) FROM public.person_cohort_snapshots WHERE snapshot_id = 'person-cohort-0106-rollback'`,
        )
      ).rows[0].count,
    ),
    0,
  );
  await pool.query(`
    DROP TRIGGER fail_person_cohort_import ON public.person_cohort_imports;
    DROP FUNCTION public.fail_person_cohort_import()
  `);
  await assert.rejects(
    pool.query(`UPDATE public.person_cohort_imports SET evidence_ref = 'changed'`),
    /Person cohort evidence is immutable/,
  );

  evidence = {
    contract: "0106",
    sourceRevision: (await commandOutput("git", ["rev-parse", "HEAD"], workspace.root)).trim(),
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
  if (pool) await pool.end().catch(() => undefined);

  await postgres?.stop().catch(() => undefined);
  await removeWorkspace(workspace.artifacts);
}

assert.ok(evidence, "rehearsal must complete before evidence is emitted");

process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
