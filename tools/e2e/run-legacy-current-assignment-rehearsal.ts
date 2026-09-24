import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { databaseHealth } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { databaseSchemaRevision } from "@vektorprogrammet/database/migrations";
import { importPersonCohort } from "@vektorprogrammet/database/person-cohort";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { CurrentAssignmentReview, type ReconciledCurrentAssignmentSnapshot } from "@vektorprogrammet/placements/contracts";
import { decodeReconciledCurrentAssignmentSnapshot, importReconciledCurrentAssignmentCohort } from "@vektorprogrammet/placements/server";
import { Effect, Redacted, Schema } from "effect";
import { Pool } from "pg";
import { buildLegacyReferences, seedLegacyReferences } from "./legacy-cutover-references";
import { buildLegacyCurrentAssignmentSnapshot } from "./legacy-current-assignment-snapshot";
import { buildLegacyPersonSnapshot } from "./legacy-person-snapshot";
import { readLegacySourceSnapshot, type LegacySourceSnapshot } from "./legacy-source-snapshot";
import { CutoverStageFailure, runLegacyServiceCutover } from "./run-legacy-service-cutover";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let stage = "Options";

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

// This is deliberately synthetic, not a backup or an assertion about live assignments.
// Names, nullability, legacy vocabularies and six InnoDB tables match the reader contract.
const fixtureSql = `
CREATE DATABASE vektor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE vektor;
CREATE TABLE user (
  id INT PRIMARY KEY, is_active TINYINT NOT NULL,
  firstName VARCHAR(255), lastName VARCHAR(255), email VARCHAR(255), phone VARCHAR(255),
  user_name VARCHAR(255), companyEmail VARCHAR(255), password VARCHAR(255)
) ENGINE=InnoDB;
CREATE TABLE department (
  id INT PRIMARY KEY, name VARCHAR(255) NOT NULL, short_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL, address VARCHAR(255), city VARCHAR(255) NOT NULL,
  latitude VARCHAR(255), longitude VARCHAR(255), slackChannel VARCHAR(255), logo_path VARCHAR(255),
  active TINYINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE semester (
  id INT PRIMARY KEY, semesterTime VARCHAR(255) NOT NULL, year VARCHAR(4) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE school (
  id INT PRIMARY KEY, name VARCHAR(255) NOT NULL, contactPerson VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL, phone VARCHAR(255) NOT NULL,
  international TINYINT NOT NULL, active TINYINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE department_school (
  department_id INT NOT NULL, school_id INT NOT NULL, PRIMARY KEY(department_id, school_id),
  FOREIGN KEY(department_id) REFERENCES department(id), FOREIGN KEY(school_id) REFERENCES school(id)
) ENGINE=InnoDB;
CREATE TABLE assistant_history (
  id INT PRIMARY KEY, user_id INT, department_id INT, semester_id INT, school_id INT,
  workdays VARCHAR(255), bolk VARCHAR(255), day VARCHAR(255),
  FOREIGN KEY(user_id) REFERENCES user(id), FOREIGN KEY(department_id) REFERENCES department(id),
  FOREIGN KEY(semester_id) REFERENCES semester(id), FOREIGN KEY(school_id) REFERENCES school(id)
) ENGINE=InnoDB;
INSERT INTO user VALUES
  (1,1,'Synthetic','One','one@example.invalid','12345678',NULL,NULL,NULL),
  (2,1,'Synthetic','Two','two@example.invalid','12345678',NULL,NULL,NULL),
  (3,1,'Synthetic','Unresolved','not-an-email','12345678',NULL,NULL,NULL),
  (4,1,'Synthetic','Four','four@example.invalid','12345678',NULL,NULL,NULL),
  (5,1,'Synthetic','Five','five@example.invalid','12345678',NULL,NULL,NULL),
  (6,1,'Synthetic','Six','six@example.invalid','12345678',NULL,NULL,NULL),
  (7,0,'Synthetic','Inactive','inactive@example.invalid','12345678',NULL,NULL,NULL);
INSERT INTO department VALUES
  (1,'Synthetic department','SYN','department@example.invalid',NULL,'Synthetic city',NULL,NULL,NULL,NULL,1);
INSERT INTO semester VALUES (1,'Vår','2026'),(2,'Høst','2026'),(3,'Vår','2027');
INSERT INTO school VALUES
  (1,'Synthetic school','Synthetic contact','school@example.invalid','12345678',0,1);
INSERT INTO department_school VALUES (1,1);
INSERT INTO assistant_history VALUES
  (101,1,1,2,1,'8','Bolk 1','Mandag'),
  (102,1,1,2,1,'4','Bolk 2','Tirsdag'),
  (103,2,1,2,1,'6','Bolk 1, Bolk 2','Onsdag'),
  (104,3,1,2,1,'2','Bolk 1','Torsdag'),
  (105,4,1,2,1,'2','Bolk 1','Lørdag'),
  (106,5,1,2,1,'9','Bolk 1','Fredag'),
  (107,6,1,2,1,'2','unrecognized','Fredag'),
  (108,7,1,2,1,'2','Bolk 1','Fredag'),
  (109,1,1,2,1,'8','Bolk 1','Mandag'),
  (201,1,1,1,1,'8','Bolk 1','Mandag');
CREATE USER 'legacy_assignment_reader'@'localhost';
GRANT SELECT ON vektor.* TO 'legacy_assignment_reader'@'localhost';
`;

// Keep the same bounded, redacted subprocess lifecycle as the backup Person rehearsal.
const run = async (command: ReadonlyArray<string>, stdin?: string, env?: Record<string, string>): Promise<string> => {
  const child = spawn(command[0]!, command.slice(1), {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.resume();
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once("error", () => reject(new Error("Local command unavailable; details redacted")));
    child.once("close", (status) => resolveExit(status ?? 1));
  });
  assert.equal(code, 0, "Local command failed; details redacted");

  return Buffer.concat(chunks).toString("utf8").trim();
};

const waitForProcessExit = async (child: ChildProcess, timeoutMs: number): Promise<boolean> =>
  await new Promise<boolean>((resolveExit) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });

const stopProcess = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForProcessExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (await waitForProcessExit(child, 5_000)) return;
  throw new Error("Disposable service did not terminate; details redacted");
};

const waitFor = async (probe: () => Promise<void>): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await probe();
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("Disposable database did not become ready; details redacted");
};

const sourceRevision = (source: LegacySourceSnapshot): string => {
  const { credentials: _credentials, ...nonCredentialSource } = source;
  return digest(nonCredentialSource);
};

const reviewFor = (source: LegacySourceSnapshot): CurrentAssignmentReview => {
  return Schema.decodeUnknownSync(CurrentAssignmentReview)({
    sourceRevision: sourceRevision(source),
    sourceWatermark: "synthetic-source-2026-09-24",
    sourceSemesterId: "legacy-semester:2",
    asOf: "2026-09-24",
    attestedBy: "synthetic-rehearsal-reviewer",
    evidenceRef: "synthetic-review-only",
    assignments: source.history.filter((row) => String(row.semesterId) === "2").map((row) => ({
      sourceAssignmentId: `legacy-history:${row.id}`,
      sourceRowDigest: digest(row),
      active: String(row.id) !== "109",
      affiliationEvidenceRef: `synthetic-affiliation:${row.id}`,
      placementEvidenceRef: `synthetic-placement:${row.id}`,
      ...(row.bolk === "Bolk 1, Bolk 2" ? { bothBlocksShareDay: true } : {}),
    })),
  });
};

// Full persisted target rows, not selected counts, establish refusal/rollback/replay stability.
// PostgreSQL formats identifiers from its own catalog, as in the existing assignment rehearsal.
const targetFingerprint = async (pool: Pool): Promise<string> => {
  const tables = (await pool.query<{ table_name: string }>(`
    SELECT format('%I.%I', schemaname, tablename) AS table_name FROM pg_tables
    WHERE schemaname IN ('public','auth') ORDER BY schemaname, tablename
  `)).rows;
  const facts: Record<string, Schema.Json> = {};
  for (const { table_name: table } of tables) {
    const result = await pool.query<{ rows: unknown }>(`
      SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY to_jsonb(value)::text), '[]'::jsonb) AS rows
      FROM ${table} value
    `);
    facts[table] = Schema.decodeUnknownSync(Schema.Json)(result.rows[0]!.rows);
  }
  return digest(facts);
};

const forbiddenFacts = async (pool: Pool): Promise<Record<string, number>> => {
  const tables = (await pool.query<{ table_name: string }>(`
    SELECT format('%I.%I', schemaname, tablename) AS table_name FROM pg_tables
    WHERE schemaname IN ('public','auth')
      AND (tablename LIKE '%audit%' OR tablename LIKE '%outbox%' OR tablename LIKE '%grant%'
        OR tablename LIKE '%membership%' OR tablename LIKE '%command_receipt%'
        OR tablename IN ('school_service_occurrences','school_service_absences','school_service_demand',
          'service_principals'))
      AND NOT (schemaname = 'auth' AND tablename = 'identity_security_audit')
    ORDER BY schemaname, tablename
  `)).rows;
  const counts: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    counts[table] = Number((await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]!.count);
    assert.equal(counts[table], 0, `Import fabricated facts in ${table}`);
  }
  // Account import security evidence is expected; it is not a human placement decision.
  assert.equal((await pool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM auth.identity_security_audit
  `)).rows[0]!.count, "5");
  return counts;
};

const canonicalPlacements = async (pool: Pool) => (await pool.query<{
  person_id: string; day: string; workdays: number; block: string; active: boolean; revision: number;
}>(`
  SELECT person_id,day,workdays,block,active,revision FROM public.assistant_placements
  ORDER BY person_id,block
`)).rows;

const assertCanonical = async (pool: Pool): Promise<void> => {
  assert.deepEqual(await canonicalPlacements(pool), [
    { person_id: "legacy-person-1", day: "Monday", workdays: 8, block: "1", active: true, revision: 1 },
    { person_id: "legacy-person-1", day: "Tuesday", workdays: 4, block: "2", active: true, revision: 1 },
    { person_id: "legacy-person-2", day: "Wednesday", workdays: 6, block: "Both", active: true, revision: 1 },
  ]);
  assert.deepEqual((await pool.query(`
    SELECT person_id,department_id,status,revision FROM public.organization_volunteer_affiliations
    ORDER BY person_id
  `)).rows, [
    { person_id: "legacy-person-1", department_id: "legacy-department:1", status: "Active", revision: 1 },
    { person_id: "legacy-person-2", department_id: "legacy-department:1", status: "Active", revision: 1 },
  ]);
  assert.equal((await pool.query(`
    SELECT count(*)::text AS count FROM public.assistant_placements
    WHERE semester_id <> 'legacy-semester:2'
  `)).rows[0].count, "0");
};

const assertAppendOnly = async (pool: Pool): Promise<void> => {
  const columns = {
    current_assignment_snapshots: "source_revision",
    current_assignment_occurrences: "reason",
    current_assignment_imports: "affiliation_evidence_ref",
    current_assignment_affiliation_imports: "source_assignment_id",
    current_assignment_reviews: "review",
  };
  const before = await targetFingerprint(pool);
  for (const [table, column] of Object.entries(columns)) {
    await assert.rejects(pool.query(`UPDATE public.${table} SET ${column} = ${column}`), /append-only/);
    await assert.rejects(pool.query(`DELETE FROM public.${table}`), /append-only/);
    await assert.rejects(pool.query(`TRUNCATE public.${table} CASCADE`), /append-only/);
  }
  assert.equal(await targetFingerprint(pool), before, "Append-only refusal changed target facts");
};

const runRehearsal = async (temporaryRoot: string) => {
  const mysqlRoot = join(temporaryRoot, "mysql");
  const postgresRoot = join(temporaryRoot, "postgres");
  const mysqlData = join(mysqlRoot, "data");
  const mysqlSocket = join(mysqlRoot, "mysql.sock");
  let mysqlProcess: ChildProcess | undefined;
  let postgresStarted = false;
  let processesStopped = true;
  const pools: Pool[] = [];
  const mysql = (sql: string) => run([
    "mariadb", "--no-defaults", "--batch", "--raw", "--skip-column-names", "--socket", mysqlSocket, "-uroot",
  ], sql);
  const target = async (database: string) => {
    await run(["createdb", "-h", postgresRoot, "-p", "5432", "-U", "postgres", database]);
    const selection = new URL(`postgresql://postgres@localhost/${database}`);
    selection.searchParams.set("host", postgresRoot);
    selection.searchParams.set("port", "5432");
    const url = selection.toString();
    await Effect.runPromise(databaseHealth.pipe(Effect.provide(DatabaseLive({
      url: Redacted.make(url), applicationName: "synthetic-current-assignment-rehearsal", maxConnections: 2,
    }))));
    const pool = new Pool({ connectionString: url, max: 3 });
    pools.push(pool);
    return { pool, url, database };
  };

  try {
    stage = "PrivateDatabaseSetup";
    await mkdir(mysqlRoot, { mode: 0o700 });
    await mkdir(postgresRoot, { mode: 0o700 });
    await mkdir(mysqlData, { mode: 0o700 });
    await run(["mariadb-install-db", "--no-defaults", `--datadir=${mysqlData}`,
      "--auth-root-authentication-method=normal", "--skip-test-db"]);
    mysqlProcess = spawn("mariadbd", [
      "--no-defaults", `--datadir=${mysqlData}`, `--socket=${mysqlSocket}`,
      `--pid-file=${join(mysqlRoot, "mysql.pid")}`, `--log-error=${join(mysqlRoot, "mysql.log")}`,
      "--skip-networking",
    ], { cwd: repositoryRoot, stdio: "ignore" });
    mysqlProcess.once("error", () => undefined);
    await waitFor(async () => { await mysql("SELECT 1"); });
    await mysql(fixtureSql);
    await run(["initdb", "-D", postgresRoot, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"]);
    postgresStarted = true;
    await run(["pg_ctl", "-D", postgresRoot, "-l", join(postgresRoot, "postgres.log"),
      "-o", `-c listen_addresses= -k ${postgresRoot} -p 5432`, "-w", "start"]);

    const sourceUrl = new URL("mysql://legacy_assignment_reader@localhost/vektor");
    sourceUrl.searchParams.set("socketPath", mysqlSocket);
    stage = "SourceReaderAndRevision";
    const source = await readLegacySourceSnapshot(sourceUrl.toString());
    assert.equal(source.history.length, 10);
    assert.equal(source.users.length, 7);
    const review = reviewFor(source);
    assert.equal(review.assignments.length, 9);
    // Exercise the actual source reader before comparing revisions; credential bytes never enter evidence.
    await mysql("UPDATE vektor.user SET password = 'synthetic-credential-change' WHERE id = 1");
    const credentialChanged = await readLegacySourceSnapshot(sourceUrl.toString());
    assert.notEqual(digest(source.credentials), digest(credentialChanged.credentials));
    assert.equal(sourceRevision(credentialChanged), review.sourceRevision);
    await mysql("UPDATE vektor.user SET password = NULL WHERE id = 1");
    const writerUrl = new URL(sourceUrl);
    writerUrl.username = "root";
    await assert.rejects(readLegacySourceSnapshot(writerUrl.toString()), /Grants/);

    const primary = await target("assignment_reviewed");
    const options = {
      sourceUrl: sourceUrl.toString(), targetUrl: primary.url, targetDatabase: primary.database,
      snapshotId: "synthetic-current-assignment-2026", attestedBy: "synthetic-rehearsal-reviewer",
      passwordlessPolicy: "ProvisionRecovery" as const, currentAssignments: review,
    };
    const untouched = await targetFingerprint(primary.pool);
    const refusals: string[] = [];
    const refuseReview = async (name: string, altered: CurrentAssignmentReview) => {
      stage = name;
      await assert.rejects(runLegacyServiceCutover({ ...options, currentAssignments: altered }));
      assert.equal(await targetFingerprint(primary.pool), untouched, `${name} changed target facts`);
      refusals.push(name);
    };
    await refuseReview("missing-entry", { ...review, assignments: review.assignments.slice(1) });
    await refuseReview("duplicate-entry", { ...review, assignments: [...review.assignments, review.assignments[0]!] });
    await refuseReview("unknown-entry", { ...review, assignments: [
      ...review.assignments, { ...review.assignments[0]!, sourceAssignmentId: "legacy-history:999" },
    ] });
    await refuseReview("changed-row-digest", { ...review, assignments: review.assignments.map((entry, index) =>
      index === 0 ? { ...entry, sourceRowDigest: "0".repeat(64) } : entry) });
    await refuseReview("changed-source-revision", { ...review, sourceRevision: "0".repeat(64) });
    await refuseReview("wrong-semester", { ...review, sourceSemesterId: "legacy-semester:1" });
    await refuseReview("empty-semester", { ...review, sourceSemesterId: "legacy-semester:3", assignments: [] });
    await refuseReview("out-of-semester-date", { ...review, asOf: "2026-01-24" });
    await refuseReview("invalid-calendar-date", { ...review, asOf: "2026-09-31" });
    await refuseReview("missing-combined-day-confirmation", { ...review, assignments: review.assignments.map((entry) => {
      const { bothBlocksShareDay: _confirmation, ...unconfirmed } = entry;
      return unconfirmed;
    }) });
    await mysql("UPDATE vektor.assistant_history SET day = 'Tirsdag' WHERE id = 101");
    await refuseReview("changed-source-row", review);
    await mysql("UPDATE vektor.assistant_history SET day = 'Mandag' WHERE id = 101");

    stage = "WholeCutoverRollback";
    // A last-stage account failure must roll back references, People, history AND current assignments.
    await primary.pool.query(`
      CREATE FUNCTION auth.fail_assignment_rehearsal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic account-stage failure'; END; $$;
      CREATE TRIGGER fail_assignment_rehearsal BEFORE INSERT ON auth.account_cohort_imports
      FOR EACH ROW EXECUTE FUNCTION auth.fail_assignment_rehearsal();
    `);
    await assert.rejects(runLegacyServiceCutover(options), (cause: unknown) =>
      cause instanceof CutoverStageFailure && cause.stage === "AccountImport");
    assert.equal(await targetFingerprint(primary.pool), untouched, "Whole cutover did not roll back");
    await primary.pool.query(`
      DROP TRIGGER fail_assignment_rehearsal ON auth.account_cohort_imports;
      DROP FUNCTION auth.fail_assignment_rehearsal();
    `);
    stage = "CutoverCLI";
    const reviewFile = join(temporaryRoot, "assignment review.json");
    await writeFile(reviewFile, JSON.stringify(review), { mode: 0o600, flag: "wx" });
    const cliOutput = await run([
      process.execPath, "--no-env-file", join(repositoryRoot, "tools/e2e/run-legacy-service-cutover.ts"),
      "--source-url-env=REHEARSAL_SOURCE_URL", "--target-url-env=REHEARSAL_TARGET_URL",
      `--target-database=${primary.database}`, `--snapshot-id=${options.snapshotId}`,
      `--attested-by=${options.attestedBy}`, "--passwordless-policy=provision-recovery",
      `--current-assignments=${reviewFile}`,
    ], undefined, { REHEARSAL_SOURCE_URL: options.sourceUrl, REHEARSAL_TARGET_URL: options.targetUrl });
    const cliReport = Schema.decodeUnknownSync(Schema.Struct({
      source: Schema.Struct({ revision: Schema.String }),
      currentAssignments: Schema.Struct({ accepted: Schema.Int, quarantined: Schema.Int }),
    }))(JSON.parse(cliOutput));
    assert.deepEqual(cliReport, { source: { revision: review.sourceRevision },
      currentAssignments: { accepted: 3, quarantined: 6 } });
    for (const value of source.users.flatMap((user) => [user.email, user.firstName, user.phone]))
      if (typeof value === "string" && value.length > 0)
        assert.equal(cliOutput.includes(value), false, "CLI report contains a personal field");
    stage = "CanonicalAssignments";
    const first = await runLegacyServiceCutover(options);
    assert.notEqual(first.currentAssignments, "NotImported");
    assert.equal(first.source.revision, review.sourceRevision);
    assert.deepEqual({ accepted: first.person.accepted, quarantined: first.person.quarantined }, { accepted: 5, quarantined: 2 });
    assert.deepEqual({ input: first.historicalService.input, accepted: first.historicalService.accepted }, { input: 1, accepted: 1 });
    assert.ok(typeof first.currentAssignments !== "string");
    assert.deepEqual({ input: first.currentAssignments.input, accepted: first.currentAssignments.accepted,
      quarantined: first.currentAssignments.quarantined }, { input: 9, accepted: 3, quarantined: 6 });
    await assertCanonical(primary.pool);
    const dispositions = (await primary.pool.query<{ occurrence_id: string; disposition: string; reason: string }>(`
      SELECT occurrence_id,disposition,reason FROM public.current_assignment_occurrences ORDER BY occurrence_id
    `)).rows;
    assert.deepEqual(dispositions.filter((row) => row.reason === "Imported").map((row) => row.occurrence_id),
      ["legacy-history-row-101", "legacy-history-row-102", "legacy-history-row-103"]);
    assert.equal(dispositions.filter((row) => row.reason === "InvalidRow").length, 3);
    assert.equal(dispositions.find((row) => row.occurrence_id === "legacy-history-row-109")?.reason, "Inactive");
    for (const id of [104, 108]) {
      assert.equal(dispositions.find((row) => row.occurrence_id === `legacy-history-row-${id}`)?.disposition, "Quarantined");
    }
    const ledger = (await primary.pool.query<{ review: unknown; source_kind: string; source_semester_id: string; as_of: string }>(`
      SELECT review,source_kind,source_semester_id,as_of::text FROM public.current_assignment_reviews
    `)).rows;
    assert.deepEqual(ledger, [{ review, source_kind: "ReviewedLegacy", source_semester_id: review.sourceSemesterId, as_of: review.asOf }]);
    assert.equal((await primary.pool.query(`
      SELECT count(*)::text AS count FROM public.current_assignment_reviews r
      JOIN public.current_assignment_snapshots a ON a.snapshot_key = r.snapshot_key
      JOIN public.historical_service_reference_provenance p
        ON p.source_repository = a.source_repository AND p.snapshot_id = a.snapshot_id
        AND p.source_revision = a.source_revision AND p.reference_digest = r.reference_digest
      JOIN public.person_cohort_snapshots s ON s.snapshot_key = r.person_snapshot_key
        AND s.source_revision = a.source_revision AND s.snapshot_id = a.snapshot_id
    `)).rows[0].count, "1");
    stage = "AppendOnlyAndExcludedFacts";
    const noFabricatedFacts = await forbiddenFacts(primary.pool);
    await assertAppendOnly(primary.pool);
    const committed = await targetFingerprint(primary.pool);
    await runLegacyServiceCutover(options);
    assert.equal(await targetFingerprint(primary.pool), committed, "Exact replay changed imported facts");
    await assert.rejects(runLegacyServiceCutover({ ...options, currentAssignments: { ...review, evidenceRef: "changed-review" } }));
    assert.equal(await targetFingerprint(primary.pool), committed, "Changed review changed committed facts");
    stage = "ReferenceAndPersonProvenance";
    const provenance = await target("assignment_provenance");
    const references = buildLegacyReferences(source);
    const provenanceIdentity = {
      sourceRepository: "vektorprogrammet/vektorprogrammet", sourceRevision: review.sourceRevision,
      snapshotId: options.snapshotId,
    };
    await seedLegacyReferences(provenance.pool, provenanceIdentity, references);
    const personSnapshot = buildLegacyPersonSnapshot(source.users, {
      sourceRevision: review.sourceRevision, snapshotId: options.snapshotId,
      transformationRevision: first.source.transformationRevision, attestedBy: options.attestedBy,
    });
    const personReport = await importPersonCohort(provenance.pool, personSnapshot);
    const projected = buildLegacyCurrentAssignmentSnapshot(source, personReport, personSnapshot, review, {
      snapshotId: options.snapshotId, transformationRevision: first.source.transformationRevision,
      referenceDigest: references.referenceDigest,
    });
    const rehash = (snapshot: ReconciledCurrentAssignmentSnapshot) => {
      const { snapshotDigest: _snapshotDigest, ...unsigned } = snapshot;
      return decodeReconciledCurrentAssignmentSnapshot({ ...unsigned, snapshotDigest: digest(unsigned) });
    };
    const provenanceBefore = await targetFingerprint(provenance.pool);
    for (const [name, candidate] of [
      ["wrong-reference-digest", { ...projected, referenceDigest: "0".repeat(64) }],
      ["wrong-person-snapshot", { ...projected, personSnapshotKey: "0".repeat(64) }],
      ["native-existence-without-source-provenance", { ...projected, snapshotId: "unseeded-assignment-snapshot",
        personSnapshotKey: digest([projected.sourceRepository, "unseeded-assignment-snapshot"]) }],
    ] as const) {
      await assert.rejects(importReconciledCurrentAssignmentCohort(provenance.pool, rehash(candidate)));
      assert.equal(await targetFingerprint(provenance.pool), provenanceBefore, name);
      refusals.push(name);
    }
    // A different accepted native Person is not the accepted mapping for this source user.
    const otherPerson = personSnapshot.mappings.find((mapping) => mapping.sourceUserId === "legacy-user:4")!;
    const wrongPersonMapping = rehash({ ...projected, mappings: projected.mappings.map((mapping) =>
      mapping.sourceAssignmentId === "legacy-history:101" ? { ...mapping, personId: otherPerson.personId } : mapping) });
    const client = await provenance.pool.connect();
    try {
      await client.query("BEGIN");
      const mismapped = await importReconciledCurrentAssignmentCohort(provenance.pool, wrongPersonMapping, client);
      assert.equal(mismapped.accepted, 2);
      assert.equal(mismapped.occurrences.find((row) => row.occurrenceId === "legacy-history-row-101")?.reason,
        "PersonReconciliationMissing");
      assert.equal((await client.query(
        "SELECT count(*)::text AS count FROM public.assistant_placements WHERE person_id = $1", [otherPerson.personId],
      )).rows[0].count, "0");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    assert.equal(await targetFingerprint(provenance.pool), provenanceBefore);
    // A fresh, self-consistent review still cannot repoint an already imported source identity.
    await mysql("UPDATE vektor.assistant_history SET user_id = 2 WHERE id = 101");
    const repointed = reviewFor(await readLegacySourceSnapshot(sourceUrl.toString()));
    await assert.rejects(runLegacyServiceCutover({ ...options, currentAssignments: repointed }));
    assert.equal(await targetFingerprint(primary.pool), committed, "Changed accepted source identity changed target");
    await mysql("UPDATE vektor.assistant_history SET user_id = 1 WHERE id = 101");
    refusals.push("changed-accepted-source-identity");

    stage = "ReplayAfterNativeEdits";
    // These are deliberate native-state edits, not fabricated human command/audit events.
    await primary.pool.query(`
      UPDATE public.assistant_placements SET day = 'Friday',workdays = 3,active = false,revision = revision + 1
      WHERE person_id = 'legacy-person-1' AND block = '1';
      UPDATE public.organization_volunteer_affiliations SET status = 'Inactive',revision = revision + 1
      WHERE person_id = 'legacy-person-2';
    `);
    const edited = await targetFingerprint(primary.pool);
    await runLegacyServiceCutover(options);
    await Promise.all([runLegacyServiceCutover(options), runLegacyServiceCutover(options)]);
    assert.equal(await targetFingerprint(primary.pool), edited, "Replay overwrote native changes");

    stage = "ConcurrentFirstImport";
    const concurrent = await target("assignment_concurrent");
    const concurrentOptions = { ...options, targetUrl: concurrent.url, targetDatabase: concurrent.database };
    const concurrentReports = await Promise.all([
      runLegacyServiceCutover(concurrentOptions), runLegacyServiceCutover(concurrentOptions),
    ]);
    assert.deepEqual(concurrentReports[0]!.currentAssignments, concurrentReports[1]!.currentAssignments);
    await assertCanonical(concurrent.pool);
    assert.deepEqual((await concurrent.pool.query(`SELECT
      (SELECT count(*) FROM public.current_assignment_snapshots)::text AS snapshots,
      (SELECT count(*) FROM public.current_assignment_reviews)::text AS reviews,
      (SELECT count(*) FROM public.current_assignment_imports)::text AS imports,
      (SELECT count(*) FROM public.current_assignment_occurrences)::text AS occurrences
    `)).rows[0], { snapshots: "1", reviews: "1", imports: "3", occurrences: "9" });
    await forbiddenFacts(concurrent.pool);

    stage = "CurrentOnlySource";
    await mysql("DELETE FROM vektor.assistant_history WHERE id = 201");
    const currentOnlySource = await readLegacySourceSnapshot(sourceUrl.toString());
    const currentOnlyReview = reviewFor(currentOnlySource);
    assert.notEqual(currentOnlyReview.sourceRevision, review.sourceRevision);
    const currentOnly = await target("assignment_current_only");
    const currentOnlyResult = await runLegacyServiceCutover({ ...options,
      targetUrl: currentOnly.url, targetDatabase: currentOnly.database, currentAssignments: currentOnlyReview,
    });
    assert.equal(currentOnlyResult.historicalService.stage, "NotImported");
    assert.equal(currentOnlyResult.historicalService.input, 0);
    await assertCanonical(currentOnly.pool);
    assert.deepEqual((await currentOnly.pool.query(`SELECT
      (SELECT count(*) FROM public.assistant_service_history)::text AS history,
      (SELECT count(*) FROM public.assistant_affiliation_history)::text AS affiliations,
      (SELECT count(*) FROM public.historical_service_snapshots)::text AS snapshots,
      (SELECT count(*) FROM public.historical_service_occurrences)::text AS occurrences
    `)).rows[0], { history: "0", affiliations: "0", snapshots: "0", occurrences: "0" });
    await forbiddenFacts(currentOnly.pool);

    return {
      scope: "FaithfulSyntheticSixTableMariaDBToDisposablePostgreSQL",
      establishesProductionParity: false, establishesLiveCurrentAssignments: false,
      source: { revision: review.sourceRevision, currentOnlyRevision: currentOnlyReview.sourceRevision,
        tables: 6, users: 7, selectedAssignments: 9, historicalRows: 1,
        sourceSemesterId: review.sourceSemesterId, asOf: review.asOf, watermark: review.sourceWatermark,
        credentialsExcludedFromRevision: true, selectOnlyReader: true },
      target: { schemaRevision: databaseSchemaRevision, placements: 3, affiliations: 2,
        acceptedPeople: 5, quarantinedPeople: 2, quarantinedAssignments: 6 },
      refusals, assignmentReasons: first.currentAssignments.reasons,
      observations: { positiveOperatorCLI: true, normalizedPlacements: true, bothBlocksExplicitlyConfirmed: true,
        acceptedPersonDependence: true, exactPersonMappingRequired: true, nativeExistenceInsufficient: true,
        inactiveDoesNotCompete: true, sameSnapshotProvenance: true,
        wholeCutoverRollback: true, exactReplayPreservesNativeEdits: true, concurrentFirstImport: true,
        concurrentReplay: true, currentOnlySource: true, appendOnlyReviewAndProvenance: true },
      privacy: { credentialsPrinted: 0, rawPersonalFieldsPrinted: 0, forbiddenFacts: noFabricatedFacts,
        accountSecurityAuditRows: 5, evidenceDirectoryMode: "0700", evidenceFileMode: "0600" },
      productionResourcesUsed: false, externalProviderActions: false,
    };
  } finally {
    let cleanupFailed = false;
    for (const pool of pools) await pool.end().catch(() => { cleanupFailed = true; });
    if (postgresStarted) {
      await run(["pg_ctl", "-D", postgresRoot, "-m", "fast", "-t", "10", "-w", "stop"])
        .catch(() => { cleanupFailed = true; });
      if (await lstat(join(postgresRoot, "postmaster.pid")).then(() => true, () => false)) {
        cleanupFailed = true;
        processesStopped = false;
      }
    }
    if (mysqlProcess) await stopProcess(mysqlProcess).catch(() => {
      cleanupFailed = true;
      processesStopped = false;
    });
    if (processesStopped) await rm(temporaryRoot, { recursive: true, force: true });
    if (cleanupFailed) throw new Error("Disposable database cleanup failed; details redacted");
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun --no-env-file tools/e2e/run-legacy-current-assignment-rehearsal.ts --evidence-dir=<new-directory>\nRuns synthetic, private socket-only MariaDB/PostgreSQL. No backup, production, or provider access.");
    return;
  }
  const output = args.length === 1 ? /^--evidence-dir=(.+)$/.exec(args[0]!)?.[1] : undefined;
  if (!output) throw new Error("Use --help or --evidence-dir=<new-directory>");
  const evidenceDirectory = resolve(output);
  // Refuse existing paths, including symlinks; never overwrite another run's evidence.
  await mkdir(evidenceDirectory, { mode: 0o700 });
  await chmod(evidenceDirectory, 0o700);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vektor-current-"));
  await chmod(temporaryRoot, 0o700);
  const report = await runRehearsal(temporaryRoot);
  const evidenceFile = join(evidenceDirectory, "report.json");
  await writeFile(evidenceFile, JSON.stringify({ ...report, ownedDatabasesCleaned: true }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  for (const [path, mode] of [[evidenceDirectory, 0o700], [evidenceFile, 0o600]] as const) {
    const metadata = await lstat(path);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.uid, process.getuid?.());
    assert.equal(metadata.mode & 0o777, mode);
  }
  console.log(JSON.stringify({ scope: report.scope, sourceRevision: report.source.revision,
    acceptedAssignments: report.target.placements, quarantinedAssignments: report.target.quarantinedAssignments,
    evidence: "owner-only-report.json", ownedDatabasesCleaned: true }, null, 2));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    console.error(`Synthetic current assignment rehearsal failed at ${stage}; details redacted`);
    process.exitCode = 1;
  });
}
