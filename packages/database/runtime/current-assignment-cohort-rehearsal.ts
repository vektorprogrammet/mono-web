/** Owned synthetic PostgreSQL current assistant assignment reconciliation journey. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Redacted } from "effect";
import { Pool } from "pg";
import { databaseHealth } from "@vektorprogrammet/database";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import {
  CurrentAssignmentFailure,
  currentAssignmentPlacementId,
  importCurrentAssignmentCohort,
} from "../src/current-assignment-cohort.js";
import { currentAssignmentForbiddenAmbientConfigurationKeys } from "../src/current-assignment-cohort-cli.js";
import { DatabaseLive } from "../src/layers.js";
import { importPersonCohort } from "../src/person-cohort.js";

const root = resolve(import.meta.dirname, "../../..");
const command = (name: string, args: ReadonlyArray<string>) =>
  execFileSync(name, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
const sourceRevision = command("git", ["rev-parse", "HEAD"]).trim();
assert.equal(command("git", ["status", "--porcelain=v1"]).trim(), "", "worktree must be clean");
const pause = (milliseconds: number) =>
  new Promise<void>((resolvePause) => setTimeout(resolvePause, milliseconds));
const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
};
const waitForPostgres = async (pool: Pool): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch {
      await pause(100);
    }
  }
  throw new Error("owned PostgreSQL readiness timeout");
};
const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop, reject) => {
    const timer = setTimeout(() => reject(new Error("owned process cleanup timeout")), 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
};
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const snapshotWithDigest = <
  Snapshot extends Record<string, unknown> & { readonly snapshotDigest?: string },
>(
  snapshot: Snapshot,
) => {
  const { snapshotDigest: _snapshotDigest, ...unsignedSnapshot } = snapshot;
  return { ...unsignedSnapshot, snapshotDigest: digest(unsignedSnapshot) };
};

for (const key of [
  "CURRENT_ASSIGNMENT_PG_URL",
  "CURRENT_ASSIGNMENT_INPUT",
  ...currentAssignmentForbiddenAmbientConfigurationKeys,
])
  assert.equal(process.env[key], undefined, `${key} ambient configuration prohibited`);

const artifacts = await mkdtemp(join(tmpdir(), "vektor-current-assignment-0109-"));
const pgdata = join(artifacts, "postgres");
const inputFile = join(artifacts, "current-assignment.json");
const backup = join(artifacts, "current-assignment.dump");
const children: ChildProcess[] = [];
let pool: Pool | undefined;
let evidence: Record<string, unknown> | undefined;

try {
  const port = await freePort();
  command("initdb", [
    "-D",
    pgdata,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  const postgres = spawn(
    "postgres",
    ["-D", pgdata, "-p", String(port), "-h", "127.0.0.1", "-k", artifacts],
    { stdio: "ignore" },
  );
  children.push(postgres);
  const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  pool = new Pool({ connectionString: adminUrl });
  await waitForPostgres(pool);
  await pool.query("CREATE DATABASE current_assignment_rehearsal");
  await pool.end();

  const databaseUrl = `postgres://postgres@127.0.0.1:${port}/current_assignment_rehearsal`;
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await Effect.runPromise(
    databaseHealth.pipe(
      Effect.provide(DatabaseLive({ url: Redacted.make(databaseUrl), maxConnections: 1 })),
    ),
  );
  await pool.query(`
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
    VALUES ('person-missing-evidence', 'Unreconciled', 'Volunteer');
    INSERT INTO public.person_contact_profiles (person_id, email, phone)
    VALUES ('person-missing-evidence', 'missing-evidence@example.invalid', '+47 900 20 001')
  `);
  const schools = (
    await pool.query<{ school_id: string; name: string }>(
      `SELECT school_id::text, name FROM public.schools_directory_schools ORDER BY school_id`,
    )
  ).rows;
  const schoolA = Number(schools[0]!.school_id);
  const schoolB = Number(schools[1]!.school_id);

  const reconciledSources = [
    "valid",
    "inactive",
    "missing-reference",
    "school-mismatch",
    "duplicate-source",
    "duplicate-target",
    "source-mismatch",
    "unowned",
    "concurrent",
    "rollback",
    "colon-left",
    "colon-right",
  ];
  const personReport = await importPersonCohort(pool, {
    sourceRepository: "synthetic-legacy",
    sourceRevision: "synthetic-person-source-0109",
    snapshotId: "person-cohort-0109",
    transformationRevision: "0109-v1",
    synthetic: true,
    occurrences: reconciledSources.map((sourceUserId) => ({
      occurrenceId: `person-${sourceUserId}`,
      row: {
        sourceUserId,
        active: true,
        firstName: "Synthetic",
        lastName: sourceUserId,
        email: `${sourceUserId}@example.invalid`,
        phone: "+47 999 00 000",
      },
    })),
    mappings: reconciledSources.map((sourceUserId) => ({
      _tag: "CreatePerson" as const,
      sourceUserId,
      personId:
        sourceUserId === "colon-left"
          ? `person:${schoolB}`
          : sourceUserId === "colon-right"
            ? "person"
            : `person-${sourceUserId}`,
      emailOwnership: {
        email: `${sourceUserId}@example.invalid`,
        attestedBy: "synthetic-operator",
        evidenceRef: `person-${sourceUserId}`,
      },
    })),
  });
  assert.equal(personReport.accepted, reconciledSources.length);
  await pool.query(`
    INSERT INTO public.organization_volunteer_affiliations
      (person_id, department_id, status, revision)
    VALUES ('person-unowned', 'department-a', 'Active', 1)
  `);

  type SourceRow = {
    sourceAssignmentId: string;
    sourceRowDigest: string;
    sourceUserId: string;
    sourceDepartmentId: string;
    sourceSemesterId: string;
    sourceSchoolId: string;
    affiliationEvidenceRef: string;
    placementEvidenceRef: string;
    day: "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday";
    workdays: number;
    block: "1" | "2" | "Both";
    active: boolean;
  };
  type Mapping = {
    sourceAssignmentId: string;
    sourceUserId: string;
    sourceDepartmentId: string;
    sourceSemesterId: string;
    sourceSchoolId: string;
    personId: string;
    departmentId: string;
    semesterId: string;
    schoolId: number;
  };
  const sourceRow = (
    sourceAssignmentId: string,
    sourceUserId: string,
    overrides: Partial<Omit<SourceRow, "sourceRowDigest">> = {},
  ): SourceRow => {
    const row = {
      sourceAssignmentId,
      sourceUserId,
      sourceDepartmentId: "legacy-department-a",
      sourceSemesterId: "legacy-semester-2026-autumn",
      sourceSchoolId: "legacy-school-a",
      affiliationEvidenceRef: `affiliation-${sourceAssignmentId}`,
      placementEvidenceRef: `placement-${sourceAssignmentId}`,
      day: "Monday" as const,
      workdays: 4,
      block: "1" as const,
      active: true,
      ...overrides,
    };
    return { ...row, sourceRowDigest: digest(row) };
  };
  const mapping = (
    row: SourceRow,
    personId: string,
    overrides: Partial<Mapping> = {},
  ): Mapping => ({
    sourceAssignmentId: row.sourceAssignmentId,
    sourceUserId: row.sourceUserId,
    sourceDepartmentId: row.sourceDepartmentId,
    sourceSemesterId: row.sourceSemesterId,
    sourceSchoolId: row.sourceSchoolId,
    personId,
    departmentId: "department-a",
    semesterId: "semester-2026-autumn",
    schoolId: schoolA,
    ...overrides,
  });
  const occurrences: Array<{ occurrenceId: string; row: unknown }> = [];
  const mappings: Mapping[] = [];
  const add = (
    sourceAssignmentId: string,
    sourceUserId: string,
    personId: string,
    rowOverrides: Partial<Omit<SourceRow, "sourceRowDigest">> = {},
    mappingOverrides: Partial<Mapping> = {},
  ) => {
    const row = sourceRow(sourceAssignmentId, sourceUserId, rowOverrides);
    occurrences.push({ occurrenceId: `occ-${sourceAssignmentId}`, row });
    mappings.push(mapping(row, personId, mappingOverrides));
    return row;
  };

  add("assignment-one", "valid", "person-valid");
  add(
    "assignment-two",
    "valid",
    "person-valid",
    { block: "2", day: "Friday", workdays: 8, sourceSchoolId: "legacy-school-b" },
    { schoolId: schoolB },
  );
  occurrences.push({ occurrenceId: "occ-invalid", row: { sourceAssignmentId: "invalid" } });
  add("inactive", "inactive", "person-inactive", { active: false });
  occurrences.push({ occurrenceId: "occ-no-mapping", row: sourceRow("no-mapping", "valid") });
  const ambiguous = add("ambiguous", "valid", "person-valid", { block: "Both" });
  mappings.push(mapping(ambiguous, "person-valid"));
  add("missing-person-evidence", "missing-evidence", "person-missing-evidence", { block: "Both" });
  add(
    "missing-reference",
    "missing-reference",
    "person-missing-reference",
    { block: "Both" },
    { departmentId: "department-missing" },
  );
  add(
    "school-mismatch",
    "school-mismatch",
    "person-school-mismatch",
    { block: "Both" },
    { departmentId: "department-b" },
  );
  const duplicateSource = add("duplicate-source", "duplicate-source", "person-duplicate-source", {
    block: "Both",
  });
  occurrences.push({ occurrenceId: "occ-duplicate-source-second", row: { ...duplicateSource } });
  add("duplicate-target-a", "duplicate-target", "person-duplicate-target", { block: "Both" });
  add("duplicate-target-b", "duplicate-target", "person-duplicate-target", { block: "Both" });
  const sourceMismatch = sourceRow("source-mismatch", "source-mismatch", { block: "Both" });
  occurrences.push({ occurrenceId: "occ-source-mismatch", row: sourceMismatch });
  mappings.push(
    mapping(sourceMismatch, "person-source-mismatch", { sourceSchoolId: "wrong-school" }),
  );
  add("unowned", "unowned", "person-unowned", { block: "Both" }, { schoolId: schoolB });

  const snapshot = snapshotWithDigest({
    sourceRepository: "synthetic-legacy",
    sourceRevision: "synthetic-current-source-0109",
    snapshotId: "current-assignment-0109",
    sourceWatermark: "synthetic-watermark-0109",
    transformationRevision: "0109-v1",
    synthetic: true,
    occurrences,
    mappings,
  });
  const importSnapshot = <
    Snapshot extends Record<string, unknown> & { readonly snapshotDigest?: string },
  >(
    input: Snapshot,
  ) => importCurrentAssignmentCohort(pool!, snapshotWithDigest(input));
  await writeFile(inputFile, JSON.stringify(snapshot), { mode: 0o600 });
  await chmod(inputFile, 0o600);
  const excludedAuthorityFacts = async (databasePool: Pool): Promise<Record<string, unknown>> => {
    const tables = (
      await databasePool.query<{ table_name: string }>(
        `SELECT format('%I.%I', schemaname, tablename) AS table_name
           FROM pg_tables
          WHERE schemaname IN ('public', 'auth')
            AND NOT (
              schemaname = 'public'
              AND tablename IN (
                'organization_volunteer_affiliations',
                'assistant_placements',
                'current_assignment_snapshots',
                'current_assignment_occurrences',
                'current_assignment_imports',
                'current_assignment_affiliation_imports'
              )
            )
          ORDER BY schemaname, tablename`,
      )
    ).rows;
    const allFacts: Record<string, unknown> = {};
    for (const { table_name: tableName } of tables) {
      const rows = await databasePool.query<{ rows: unknown }>(
        `SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY to_jsonb(value)::text), '[]'::jsonb) AS rows
           FROM ${tableName} value`,
      );
      allFacts[tableName] = rows.rows[0]!.rows;
    }
    return allFacts;
  };
  const facts = async (databasePool: Pool) => {
    const canonical = (
      await databasePool.query<{ facts: Record<string, unknown> }>(
        `SELECT jsonb_build_object(
          'canonicalAffiliations', (SELECT jsonb_agg(a ORDER BY person_id, department_id) FROM public.organization_volunteer_affiliations a),
          'canonicalPlacements', (SELECT jsonb_agg(p ORDER BY placement_id) FROM public.assistant_placements p),
          'snapshots', (SELECT jsonb_agg(s ORDER BY snapshot_key) FROM public.current_assignment_snapshots s),
          'occurrences', (SELECT jsonb_agg(o ORDER BY snapshot_key, occurrence_id) FROM public.current_assignment_occurrences o),
          'imports', (SELECT jsonb_agg(i ORDER BY source_repository, source_assignment_id) FROM public.current_assignment_imports i),
          'affiliationImports', (SELECT jsonb_agg(i ORDER BY source_repository, person_id, department_id) FROM public.current_assignment_affiliation_imports i)
        ) AS facts`,
      )
    ).rows[0]!.facts;
    return { ...canonical, excluded: await excludedAuthorityFacts(databasePool) };
  };
  const excludedBefore = digest((await facts(pool)).excluded);
  const runCli = (): unknown =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["run", "packages/database/runtime/current-assignment-cohort-main.ts"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            CURRENT_ASSIGNMENT_MODE: "synthetic",
            NATIVE_IDENTITY_DEPLOYMENT: "local",
            CURRENT_ASSIGNMENT_PG_URL: databaseUrl,
            CURRENT_ASSIGNMENT_INPUT: inputFile,
          },
        },
      ),
    );

  const cliReport = runCli();
  const report = await importSnapshot(snapshot);
  assert.deepEqual(cliReport, report, "guarded CLI returns the persisted report");
  assert.equal(report.accepted, 2);
  assert.equal(report.quarantined, occurrences.length - 2);
  assert.equal(report.currentState, "EstablishedThroughCanonicalAffiliationAndPlacement");
  assert.equal(report.audit, "ImportProvenanceOnly");
  assert.deepEqual(runCli(), report, "exact CLI replay is byte-equivalent");
  assert.deepEqual(
    (
      await pool.query(
        `SELECT person_id, department_id, status, revision
           FROM public.organization_volunteer_affiliations
          WHERE person_id = 'person-valid'`,
      )
    ).rows,
    [{ person_id: "person-valid", department_id: "department-a", status: "Active", revision: 1 }],
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT placement_id, day, workdays, block, active, revision
           FROM public.assistant_placements
          WHERE person_id = 'person-valid' ORDER BY placement_id`,
      )
    ).rows,
    [
      {
        placement_id: currentAssignmentPlacementId("synthetic-legacy", "assignment-one"),
        day: "Monday",
        workdays: 4,
        block: "1",
        active: true,
        revision: 1,
      },
      {
        placement_id: currentAssignmentPlacementId("synthetic-legacy", "assignment-two"),
        day: "Friday",
        workdays: 8,
        block: "2",
        active: true,
        revision: 1,
      },
    ].sort((left, right) => left.placement_id.localeCompare(right.placement_id)),
  );
  assert.equal(
    Number(
      (await pool.query(`SELECT count(*) FROM public.organization_volunteer_affiliation_audit`))
        .rows[0].count,
    ),
    0,
    "import fabricated a human affiliation audit action",
  );
  assert.equal(
    Number(
      (await pool.query(`SELECT count(*) FROM public.assistant_placement_audit`)).rows[0].count,
    ),
    0,
    "import fabricated a human placement audit action",
  );
  assert.equal(
    digest((await facts(pool)).excluded),
    excludedBefore,
    "import changed excluded authority",
  );
  assert.equal(
    Number(
      (
        await pool.query(
          `SELECT count(*) FROM public.current_assignment_affiliation_imports WHERE person_id = 'person-unowned'`,
        )
      ).rows[0].count,
    ),
    0,
    "unowned canonical affiliation was adopted",
  );
  assert.deepEqual(
    (
      await pool.query(`SELECT reason FROM public.current_assignment_occurrences ORDER BY reason`)
    ).rows.map(({ reason }) => reason),
    [
      "DuplicateSource",
      "DuplicateSource",
      "DuplicateTarget",
      "DuplicateTarget",
      "Imported",
      "Imported",
      "Inactive",
      "InvalidRow",
      "MappingAmbiguous",
      "MappingMissing",
      "NativeReferenceMissing",
      "PersonReconciliationMissing",
      "SchoolDepartmentMismatch",
      "SourceReferenceMismatch",
      "TargetConflict",
    ].sort(),
  );

  const collisionSemester = "semester-collision";
  const colonCollisionSemester = `${schoolA}:${collisionSemester}`;
  await pool.query(
    `INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at)
     VALUES ($1, '2026-08-01T00:00:00Z', '2026-12-31T00:00:00Z'),
            ($2, '2026-08-01T00:00:00Z', '2026-12-31T00:00:00Z')`,
    [collisionSemester, colonCollisionSemester],
  );
  const collisionLeft = sourceRow("assignment-colon-left", "colon-left");
  const collisionRight = sourceRow("assignment-colon-right", "colon-right", {
    sourceSchoolId: "legacy-school-b",
  });
  const colonCollision = await importSnapshot({
    ...snapshot,
    sourceRevision: "synthetic-current-source-0109-colon",
    snapshotId: "current-assignment-0109-colon",
    occurrences: [
      { occurrenceId: "occ-assignment-colon-left", row: collisionLeft },
      { occurrenceId: "occ-assignment-colon-right", row: collisionRight },
    ],
    mappings: [
      mapping(collisionLeft, `person:${schoolB}`, { semesterId: collisionSemester }),
      mapping(collisionRight, "person", {
        schoolId: schoolB,
        semesterId: colonCollisionSemester,
      }),
    ],
  });
  assert.deepEqual(colonCollision.occurrences, [
    { occurrenceId: "occ-assignment-colon-left", disposition: "Accepted", reason: "Imported" },
    { occurrenceId: "occ-assignment-colon-right", disposition: "Accepted", reason: "Imported" },
  ]);
  assert.equal(
    Number(
      (
        await pool.query(
          `SELECT count(*) FROM public.assistant_placements
           WHERE person_id IN ($1, $2) AND semester_id IN ($3, $4)`,
          [`person:${schoolB}`, "person", collisionSemester, colonCollisionSemester],
        )
      ).rows[0].count,
    ),
    2,
    "colon-containing target identities collapsed distinct placements",
  );
  const factsBeforeConflict = digest(await facts(pool));
  await assert.rejects(
    importSnapshot({ ...snapshot, sourceRevision: "changed-source" }),
    (cause) => cause instanceof CurrentAssignmentFailure && cause.code === "SnapshotConflict",
  );
  const changedRow = sourceRow("assignment-one", "valid", { day: "Tuesday" });
  await assert.rejects(
    importSnapshot({
      ...snapshot,
      snapshotId: "current-assignment-0109-changed-source",
      occurrences: [{ occurrenceId: "occ-assignment-one-changed", row: changedRow }],
      mappings: [mapping(changedRow, "person-valid")],
    }),
    (cause) => cause instanceof CurrentAssignmentFailure && cause.code === "SourceIdentityConflict",
  );
  assert.equal(
    digest(await facts(pool)),
    factsBeforeConflict,
    "changed replay altered persisted facts",
  );

  const overlapRow = sourceRow("assignment-overlap", "valid", { block: "Both" });
  const overlap = await importSnapshot({
    ...snapshot,
    snapshotId: "current-assignment-0109-overlap",
    occurrences: [{ occurrenceId: "occ-assignment-overlap", row: overlapRow }],
    mappings: [mapping(overlapRow, "person-valid")],
  });
  assert.deepEqual(overlap.occurrences, [
    {
      occurrenceId: "occ-assignment-overlap",
      disposition: "Quarantined",
      reason: "PlacementOverlap",
    },
  ]);

  await pool.query(
    `INSERT INTO public.assistant_placements
       (placement_id, person_id, department_id, semester_id, school_id, day, workdays, block, active, revision)
     VALUES ($1, 'person-valid', 'department-a', 'semester-2026-autumn', $2, 'Monday', 1, 'Both', true, 1)`,
    [`placement-${"d".repeat(64)}`, schoolB],
  );
  const reverseOverlapRow = sourceRow("assignment-reverse-overlap", "valid", {
    sourceSchoolId: "legacy-school-b",
  });
  const reverseOverlap = await importSnapshot({
    ...snapshot,
    snapshotId: "current-assignment-0109-reverse-overlap",
    occurrences: [{ occurrenceId: "occ-assignment-reverse-overlap", row: reverseOverlapRow }],
    mappings: [mapping(reverseOverlapRow, "person-valid", { schoolId: schoolB })],
  });
  assert.deepEqual(reverseOverlap.occurrences, [
    {
      occurrenceId: "occ-assignment-reverse-overlap",
      disposition: "Quarantined",
      reason: "PlacementOverlap",
    },
  ]);
  const concurrentRow = sourceRow("assignment-concurrent", "concurrent", { block: "Both" });
  const concurrentSnapshot = {
    ...snapshot,
    sourceRevision: "synthetic-current-source-0109-concurrent",
    snapshotId: "current-assignment-0109-concurrent",
    occurrences: [{ occurrenceId: "occ-assignment-concurrent", row: concurrentRow }],
    mappings: [mapping(concurrentRow, "person-concurrent", { schoolId: schoolB })],
  };
  const concurrent = await Promise.all([
    importSnapshot(concurrentSnapshot),
    importSnapshot(concurrentSnapshot),
  ]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal(concurrent[0].accepted, 1);
  assert.deepEqual(
    (
      await pool.query(
        `SELECT
          (SELECT count(*) FROM public.organization_volunteer_affiliations WHERE person_id = 'person-concurrent') AS affiliations,
          (SELECT count(*) FROM public.assistant_placements WHERE person_id = 'person-concurrent') AS placements,
          (SELECT count(*) FROM public.current_assignment_imports WHERE source_assignment_id = 'assignment-concurrent') AS imports`,
      )
    ).rows[0],
    { affiliations: "1", placements: "1", imports: "1" },
  );

  await pool.query(`
    CREATE FUNCTION public.fail_current_assignment_import() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER fail_current_assignment_import
    BEFORE INSERT ON public.current_assignment_imports
    FOR EACH ROW EXECUTE FUNCTION public.fail_current_assignment_import()
  `);
  const rollbackRow = sourceRow("assignment-rollback", "rollback", { block: "Both" });
  await assert.rejects(
    importSnapshot({
      ...snapshot,
      snapshotId: "current-assignment-0109-rollback",
      occurrences: [{ occurrenceId: "occ-assignment-rollback", row: rollbackRow }],
      mappings: [mapping(rollbackRow, "person-rollback", { schoolId: schoolB })],
    }),
    (cause) => cause instanceof CurrentAssignmentFailure && cause.code === "PersistenceFailure",
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT
          (SELECT count(*) FROM public.current_assignment_snapshots WHERE snapshot_id = 'current-assignment-0109-rollback') AS snapshots,
          (SELECT count(*) FROM public.organization_volunteer_affiliations WHERE person_id = 'person-rollback') AS affiliations,
          (SELECT count(*) FROM public.assistant_placements WHERE person_id = 'person-rollback') AS placements,
          (SELECT count(*) FROM public.current_assignment_imports WHERE source_assignment_id = 'assignment-rollback') AS imports`,
      )
    ).rows[0],
    { snapshots: "0", affiliations: "0", placements: "0", imports: "0" },
  );
  await pool.query(`
    DROP TRIGGER fail_current_assignment_import ON public.current_assignment_imports;
    DROP FUNCTION public.fail_current_assignment_import()
  `);
  await assert.rejects(
    pool.query(`UPDATE public.current_assignment_imports SET affiliation_evidence_ref = 'changed'`),
    /append-only/,
  );
  const appendOnlyStatements = [
    "UPDATE public.current_assignment_snapshots SET source_revision = source_revision",
    "UPDATE public.current_assignment_occurrences SET reason = reason",
    "UPDATE public.current_assignment_imports SET affiliation_evidence_ref = affiliation_evidence_ref",
    "UPDATE public.current_assignment_affiliation_imports SET source_assignment_id = source_assignment_id",
  ] as const;
  const appendOnlyTables = [
    "current_assignment_snapshots",
    "current_assignment_occurrences",
    "current_assignment_imports",
    "current_assignment_affiliation_imports",
  ] as const;
  const assertAppendOnlyProvenance = async (databasePool: Pool): Promise<void> => {
    for (const statement of appendOnlyStatements)
      await assert.rejects(databasePool.query(statement), /append-only/);
    for (const table of appendOnlyTables)
      await assert.rejects(databasePool.query(`DELETE FROM public.${table}`), /append-only/);
    for (const table of appendOnlyTables)
      await assert.rejects(databasePool.query(`TRUNCATE public.${table} CASCADE`), /append-only/);
  };
  await assertAppendOnlyProvenance(pool);

  const restoredFactsExpected = await facts(pool);
  command("pg_dump", ["--dbname", databaseUrl, "--format=custom", "--file", backup]);
  assert.ok((await stat(backup)).size > 0);
  const backupChecksum = createHash("sha256")
    .update(await readFile(backup))
    .digest("hex");
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query("CREATE DATABASE current_assignment_restored");
  await admin.end();
  const restoredUrl = `postgres://postgres@127.0.0.1:${port}/current_assignment_restored`;
  command("pg_restore", ["--dbname", restoredUrl, backup]);
  const restored = new Pool({ connectionString: restoredUrl });
  assert.deepEqual(await facts(restored), restoredFactsExpected);
  await assertAppendOnlyProvenance(restored);
  await restored.end();

  assert.equal(
    command("git", ["rev-parse", "HEAD"]).trim(),
    sourceRevision,
    "source revision changed",
  );
  assert.equal(command("git", ["status", "--porcelain=v1"]).trim(), "", "worktree changed");

  evidence = {
    contract: "0109",
    sourceRevision,
    report,
    oneAffiliationForTwoPlacements: true,
    deterministicPlacementIdentity: true,
    colonDelimitedTargetsIndependent: true,
    quarantinesPreserveCanonicalState: true,
    unownedCanonicalTargetNotAdopted: true,
    exactReplayByteStable: true,
    changedSnapshotRejected: true,
    changedAcceptedSourceRejected: true,
    concurrentFirstImport: true,
    forcedRollback: true,
    appendOnlyProvenance: true,
    excludedAuthoritiesUnchanged: true,
    noHumanOperationalAuditFabricated: true,
    backup: { nonempty: true, restored: true, sha256: backupChecksum },
    productionEffects: "none",
  };
} finally {
  if (pool) await pool.end().catch(() => undefined);
  for (const child of children.reverse()) await stop(child).catch(() => undefined);
  await rm(artifacts, { recursive: true, force: true });
}

assert.ok(evidence, "rehearsal must complete before evidence is emitted");
process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
