import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { databaseHealth } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { databaseSchemaRevision } from "@vektorprogrammet/database/migrations";
import {
  decodePersonCohort,
  importPersonCohort,
  personCohortSourceRowDigest,
  PersonCohortFailure,
  type PersonCohortReport,
  type PersonCohortSnapshot,
} from "@vektorprogrammet/database/person-cohort";
import { readOwnProfile } from "@vektorprogrammet/database/profile";
import { canonicalJson } from "@vektorprogrammet/domain/evidence";
import { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, Redacted, Schema } from "effect";
import { Pool } from "pg";
import { buildLegacyPersonSnapshot, type LegacyUserJson } from "./legacy-person-snapshot";
import { runLegacyServiceCutover } from "./run-legacy-service-cutover";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(moduleFile), "../..");
const expectedSourceSha256 = "0ee71a6d3009181f1711ca9ee73917a8945c340d1ecd9f729ba12ecd57a88df5";
const expectedSourceSize = 8_254_002;
const expectedPersonReportFingerprint =
  "c756dd07171521c0db72abdef1f531255ac311ed5014aae667d8fab26f21c299";
const expectedLegacyShape = {
  tables: 65,
  entityTables: 48,
  relationTables: 16,
  migrationTables: 1,
  columns: 349,
  foreignKeys: 94,
  appliedMigrations: 71,
  declaredMigrations: 72,
  people: 2_923,
  activePeople: 2_910,
} as const;

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const digest = (value: unknown): string => sha256(canonicalJson(value));
const toInt = (value: unknown): number => {
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed), "Expected an integer aggregate");
  return parsed;
};

interface SpawnOptions {
  readonly cwd?: string;
  readonly stdin?: Uint8Array;
  readonly env?: Record<string, string | undefined>;
  readonly redactStderr?: boolean;
}

const run = async (command: ReadonlyArray<string>, options: SpawnOptions = {}): Promise<string> => {
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (options.stdin === undefined) child.stdin.end();
  else child.stdin.end(options.stdin);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const exitCode = await new Promise<number>((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveClose(code ?? 1));
  });
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (exitCode !== 0) {
    const details = options.redactStderr ? "details redacted" : stderr.slice(-2_000);
    throw new Error(String(command[0]) + " failed (" + exitCode + "): " + details);
  }
  return stdout.trim();
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

const freePort = async (): Promise<number> =>
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      const port = address.port;
      server.close((error) => (error === undefined ? resolvePort(port) : reject(error)));
    });
  });

const waitFor = async (probe: () => Promise<void>, label: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await probe();
      return;
    } catch (error) {
      last = error;
      await delay(100);
    }
  }
  throw new Error(`${label} did not become ready: ${String(last)}`);
};

const secureRegularFile = async (path: string, expectedMode: number): Promise<void> => {
  const metadata = await lstat(path);
  assert.ok(metadata.isFile(), "Private artifact must be a regular file");
  assert.equal(metadata.isSymbolicLink(), false, "Private artifact must not be a symbolic link");
  assert.equal(metadata.nlink, 1, "Private artifact must not be hard-linked");
  assert.equal(metadata.uid, process.getuid?.(), "Private artifact must be owned by this user");
  assert.equal(metadata.mode & 0o777, expectedMode, "Private artifact has an unsafe mode");
};
const readPrivateFile = async (path: string, maxBytes: number): Promise<Buffer> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    assert.ok(metadata.isFile(), "Private input must be a regular file");
    assert.equal(metadata.nlink, 1, "Private input must not be hard-linked");
    assert.equal(metadata.uid, process.getuid?.(), "Private input must be owned by this user");
    assert.equal(metadata.mode & 0o777, 0o600, "Private input mode must be 600");
    assert.ok(metadata.size <= maxBytes, "Private input exceeds its accepted size");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const readPrivateJson = async (path: string): Promise<unknown> =>
  JSON.parse((await readPrivateFile(path, 16 * 1024 * 1024)).toString("utf8"));

const mysql = async (socket: string, sql: string): Promise<string> =>
  run([
    "mariadb",
    "--batch",
    "--raw",
    "--skip-column-names",
    "--socket",
    socket,
    "-uroot",
    "vektor",
    "-e",
    sql,
  ]);

const jsonLines = <A>(output: string): ReadonlyArray<A> =>
  output === "" ? [] : output.split("\n").map((line) => JSON.parse(line) as A);

const phpFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".php")) files.push(path);
    }
  };
  await visit(root);
  return files;
};

const doctrineEntityTables = async (): Promise<ReadonlySet<string>> => {
  const root = join(repositoryRoot, "apps/server/src");
  const tables = new Set<string>();
  for (const path of await phpFiles(root)) {
    const source = await readFile(path, "utf8");
    if (!source.includes("#[ORM\\Entity")) continue;
    const explicit = source.match(/#\[ORM\\Table\(name:\s*['"]([^'"]+)['"]/)?.[1];
    const className = source.match(/\bclass\s+(\w+)/)?.[1];
    assert.ok(
      explicit !== undefined || className !== undefined,
      "Doctrine entity has no table identity",
    );
    tables.add(explicit ?? className!);
  }
  return tables;
};

const startNativeDatabase = async (dataRoot: string, port: number): Promise<void> => {
  await run([
    "initdb",
    "-D",
    dataRoot,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  const logPath = join(dataRoot, "postgres.log");
  try {
    await run([
      "pg_ctl",
      "-D",
      dataRoot,
      "-l",
      logPath,
      "-o",
      "-c listen_addresses= -k " + dataRoot + " -p " + String(port),
      "-w",
      "start",
    ]);
  } catch (error) {
    const log = await readFile(logPath, "utf8").catch(() => "PostgreSQL log unavailable");
    throw new Error(String(error) + "\n" + log.slice(-2_000));
  }
};
const postgresUrl = (socketRoot: string, port: number, database: string): string => {
  const url = new URL("postgresql://postgres@localhost/" + database);
  url.searchParams.set("host", socketRoot);
  url.searchParams.set("port", String(port));
  return url.toString();
};

const migrateNativeDatabase = async (url: string): Promise<void> => {
  await Effect.runPromise(
    databaseHealth.pipe(
      Effect.provide(
        DatabaseLive({
          url: Redacted.make(url),
          applicationName: "legacy-backup-person-rehearsal",
          maxConnections: 2,
        }),
      ),
    ),
  );
};

const nativeCounts = async (pool: Pool): Promise<Record<string, number>> => {
  const result = await pool.query<Record<string, string>>(`
    SELECT
      (SELECT count(*) FROM public.person_profiles)::text AS profiles,
      (SELECT count(*) FROM public.person_contact_profiles)::text AS contacts,
      (SELECT count(*) FROM public.profile_http_versions)::text AS http_versions,
      (SELECT count(*) FROM public.person_cohort_snapshots)::text AS snapshots,
      (SELECT count(*) FROM public.person_cohort_occurrences)::text AS occurrences,
      (SELECT count(*) FROM public.person_cohort_imports)::text AS imports
  `);
  return Object.fromEntries(
    Object.entries(result.rows[0]!).map(([key, value]) => [key, toInt(value)]),
  );
};
const nativeStateFingerprint = async (pool: Pool): Promise<string> => {
  const rows = async (sql: string) => (await pool.query<Record<string, unknown>>(sql)).rows;
  return digest({
    profiles: await rows(
      "SELECT person_id, first_name, last_name, revision FROM public.person_profiles ORDER BY person_id",
    ),
    contacts: await rows(
      "SELECT person_id, email, phone, revision FROM public.person_contact_profiles ORDER BY person_id",
    ),
    httpVersions: await rows(
      "SELECT person_id, representation_revision FROM public.profile_http_versions ORDER BY person_id",
    ),
    snapshots: await rows(
      "SELECT snapshot_key, source_repository, snapshot_id, source_revision, transformation_revision, snapshot_digest, occurrence_count FROM public.person_cohort_snapshots ORDER BY snapshot_key",
    ),
    occurrences: await rows(
      "SELECT snapshot_key, occurrence_id, disposition, reason FROM public.person_cohort_occurrences ORDER BY snapshot_key, occurrence_id",
    ),
    imports: await rows(
      "SELECT source_repository, source_user_id, person_id, mapping_action, source_digest, evidence_ref, snapshot_key, occurrence_id FROM public.person_cohort_imports ORDER BY source_repository, source_user_id",
    ),
  });
};

const expectFailure = async (
  effect: Promise<unknown>,
  code: PersonCohortFailure["code"],
): Promise<void> => {
  try {
    await effect;
    assert.fail(`Expected ${code}`);
  } catch (error) {
    assert.ok(error instanceof PersonCohortFailure);
    assert.equal(error.code, code);
  }
};

const reasonCounts = (report: PersonCohortReport): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const occurrence of report.occurrences)
    counts[occurrence.reason] = (counts[occurrence.reason] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
};

let processCleanupComplete = true;
const runRehearsal = async (temporaryRoot: string) => {
  const sourcePath = process.env.LEGACY_BACKUP_SQL;
  assert.ok(sourcePath !== undefined, "LEGACY_BACKUP_SQL is required");
  const sourceParent = await stat(dirname(sourcePath));
  assert.equal(
    sourceParent.uid,
    process.getuid?.(),
    "Private source directory must be owned by this user",
  );
  assert.equal(sourceParent.mode & 0o777, 0o700, "Private source directory mode must be 0700");
  const sourceBytes = await readPrivateFile(sourcePath, expectedSourceSize);
  assert.equal(sourceBytes.byteLength, expectedSourceSize, "Legacy backup size mismatch");
  const sourceSha256 = sha256(sourceBytes);
  assert.equal(sourceSha256, expectedSourceSha256, "Legacy backup checksum mismatch");

  const privateRoot = join(temporaryRoot, "private");
  const mysqlRoot = join(temporaryRoot, "mysql");
  const postgresRoot = join(temporaryRoot, "postgres");
  await mkdir(privateRoot, { mode: 0o700 });
  await chmod(privateRoot, 0o700);
  await mkdir(mysqlRoot, { mode: 0o700 });
  await mkdir(postgresRoot, { mode: 0o700 });

  const mysqlData = join(mysqlRoot, "data");
  const mysqlSocket = join(mysqlRoot, "mysql.sock");
  await mkdir(mysqlData, { mode: 0o700 });
  await run([
    "mariadb-install-db",
    "--no-defaults",
    `--datadir=${mysqlData}`,
    "--auth-root-authentication-method=normal",
    "--skip-test-db",
  ]);
  processCleanupComplete = false;
  const mysqlProcess = spawn(
    "mariadbd",
    [
      "--no-defaults",
      "--datadir=" + mysqlData,
      "--socket=" + mysqlSocket,
      "--pid-file=" + join(mysqlRoot, "mysql.pid"),
      "--log-error=" + join(mysqlRoot, "mysql.log"),
      "--skip-networking",
    ],
    { cwd: repositoryRoot, stdio: "ignore" },
  );
  mysqlProcess.once("error", () => undefined);

  let postgresStarted = false;
  let pool: Pool | undefined;
  let restoredPool: Pool | undefined;
  let completedReport: Record<string, unknown> | undefined;
  let cleanupFailed = false;
  try {
    await waitFor(async () => {
      await run(["mariadb-admin", "--socket", mysqlSocket, "-uroot", "ping"]);
    }, "MariaDB");
    await run([
      "mariadb",
      "--socket",
      mysqlSocket,
      "-uroot",
      "-e",
      "CREATE DATABASE vektor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
    ]);
    await run(["mariadb", "--socket", mysqlSocket, "-uroot", "vektor"], {
      stdin: sourceBytes,
      redactStderr: true,
    });
    // Disposable socket-only source account: no writer grants and no remote transport.
    await mysql(mysqlSocket,
      "CREATE USER 'legacy_cutover_reader'@'localhost'; GRANT SELECT ON vektor.* TO 'legacy_cutover_reader'@'localhost'");

    const shape = JSON.parse(
      await mysql(
        mysqlSocket,
        `SELECT JSON_OBJECT(
          'tables', (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'vektor' AND table_type = 'BASE TABLE'),
          'columns', (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'vektor'),
          'foreignKeys', (SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema = 'vektor'),
          'migrations', (SELECT COUNT(*) FROM migration_versions),
          'people', (SELECT COUNT(*) FROM user),
          'activePeople', (SELECT COUNT(*) FROM user WHERE is_active = 1),
          'credentials', (SELECT COUNT(*) FROM user WHERE password IS NOT NULL AND password <> '')
        )`,
      ),
    ) as Record<string, number | string>;
    assert.equal(toInt(shape.tables), expectedLegacyShape.tables);
    assert.equal(toInt(shape.columns), expectedLegacyShape.columns);
    assert.equal(toInt(shape.foreignKeys), expectedLegacyShape.foreignKeys);
    assert.equal(toInt(shape.migrations), expectedLegacyShape.appliedMigrations);
    assert.equal(toInt(shape.people), expectedLegacyShape.people);
    assert.equal(toInt(shape.activePeople), expectedLegacyShape.activePeople);

    const tableNames = (
      await mysql(
        mysqlSocket,
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'vektor' AND table_type = 'BASE TABLE' ORDER BY table_name",
      )
    ).split("\n");
    const entityTables = await doctrineEntityTables();
    const migrationTables = tableNames.filter((name) => name === "migration_versions");
    const relationTables = tableNames.filter(
      (name) => !entityTables.has(name) && name !== "migration_versions",
    );
    assert.equal(entityTables.size, expectedLegacyShape.entityTables);
    assert.equal(relationTables.length, expectedLegacyShape.relationTables);
    assert.equal(migrationTables.length, expectedLegacyShape.migrationTables);
    assert.deepEqual(
      [...entityTables].filter((table) => !tableNames.includes(table)),
      [],
      "Declared Doctrine entity table missing from backup",
    );

    const appliedMigrationIds = (
      await mysql(mysqlSocket, "SELECT version FROM migration_versions ORDER BY version")
    )
      .split("\n")
      .map((version) => version.replace(/^.*Version/, ""));
    const declaredMigrationIds = (await readdir(join(repositoryRoot, "apps/server/migrations")))
      .filter((name) => /^Version.+\.php$/.test(name))
      .map((name) => name.slice("Version".length, -".php".length))
      .sort();
    assert.equal(declaredMigrationIds.length, expectedLegacyShape.declaredMigrations);
    assert.deepEqual(
      appliedMigrationIds.filter((migration) => !declaredMigrationIds.includes(migration)),
      [],
      "Backup contains an unknown legacy migration",
    );
    const postBackupMigrationIds = declaredMigrationIds.filter(
      (migration) => !appliedMigrationIds.includes(migration),
    );
    assert.deepEqual(postBackupMigrationIds, ["20260810002046"]);
    const schemaRows = jsonLines<Record<string, unknown>>(
      await mysql(
        mysqlSocket,
        `SELECT JSON_OBJECT(
          'table', table_name,
          'column', column_name,
          'ordinal', ordinal_position,
          'type', column_type,
          'nullable', is_nullable,
          'default', column_default,
          'key', column_key,
          'extra', extra
        ) FROM information_schema.columns
        WHERE table_schema = 'vektor'
        ORDER BY table_name, ordinal_position`,
      ),
    );
    const foreignKeyRows = jsonLines<Record<string, unknown>>(
      await mysql(
        mysqlSocket,
        `SELECT JSON_OBJECT(
          'name', constraint_name,
          'table', table_name,
          'referencedTable', referenced_table_name,
          'updateRule', update_rule,
          'deleteRule', delete_rule
        ) FROM information_schema.referential_constraints
        WHERE constraint_schema = 'vektor'
        ORDER BY table_name, constraint_name`,
      ),
    );
    const representativeUserConstraints = jsonLines<Record<string, unknown>>(
      await mysql(
        mysqlSocket,
        `SELECT JSON_OBJECT(
          'name', tc.constraint_name,
          'type', tc.constraint_type,
          'column', kcu.column_name,
          'referencedTable', kcu.referenced_table_name,
          'referencedColumn', kcu.referenced_column_name
        ) FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_schema = tc.constraint_schema
         AND kcu.table_name = tc.table_name
         AND kcu.constraint_name = tc.constraint_name
        WHERE tc.constraint_schema = 'vektor' AND tc.table_name = 'user'
        ORDER BY tc.constraint_name, kcu.ordinal_position`,
      ),
    );
    assert.ok(
      representativeUserConstraints.some((constraint) => constraint.type === "PRIMARY KEY"),
      "Legacy user primary key was not restored",
    );
    assert.ok(
      representativeUserConstraints.some((constraint) => constraint.type === "FOREIGN KEY"),
      "Legacy user foreign keys were not restored",
    );

    const users = jsonLines<LegacyUserJson>(
      await mysql(
        mysqlSocket,
        `SELECT JSON_OBJECT(
          'id', id,
          'active', is_active,
          'firstName', firstName,
          'lastName', lastName,
          'email', email,
          'phone', phone,
          'username', user_name,
          'companyEmail', companyEmail
        ) FROM user ORDER BY id`,
      ),
    );
    assert.equal(users.length, expectedLegacyShape.people);

    const toolRevision = sha256(await readFile(moduleFile, "utf8"));
    const snapshot = buildLegacyPersonSnapshot(users, {
      sourceRevision: sourceSha256,
      transformationRevision: toolRevision.slice(0, 32),
      snapshotId: "vektor-backup-2024-08-22",
      attestedBy: "legacy-backup-2024-08-22",
    });
    const cohortPath = join(privateRoot, "person-cohort.json");
    await writeFile(cohortPath, canonicalJson(snapshot), { mode: 0o600 });
    await chmod(cohortPath, 0o600);
    const decodedSnapshot = decodePersonCohort(await readPrivateJson(cohortPath));
    const cohortDigest = digest(decodedSnapshot);

    const postgresPort = await freePort();
    postgresStarted = true;
    await startNativeDatabase(postgresRoot, postgresPort);
    await assert.rejects(
      run(["pg_isready", "-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres"]),
      /pg_isready failed/,
      "Disposable PostgreSQL unexpectedly exposed TCP",
    );
    const nativeDatabase = "person_cohort_rehearsal";
    const restoredDatabase = "person_cohort_restored";
    await run([
      "createdb",
      "-h",
      postgresRoot,
      "-p",
      String(postgresPort),
      "-U",
      "postgres",
      nativeDatabase,
    ]);
    const nativeUrl = postgresUrl(postgresRoot, postgresPort, nativeDatabase);
    await migrateNativeDatabase(nativeUrl);
    pool = new Pool({ connectionString: nativeUrl, max: 4 });

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.fail_person_rehearsal_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'deliberate Person rehearsal rollback';
      END;
      $$;
      CREATE TRIGGER fail_person_rehearsal_insert
      BEFORE INSERT ON public.person_profiles
      FOR EACH ROW EXECUTE FUNCTION public.fail_person_rehearsal_insert();
    `);
    await expectFailure(importPersonCohort(pool, decodedSnapshot), "PersistenceFailure");
    assert.deepEqual(await nativeCounts(pool), {
      profiles: 0,
      contacts: 0,
      http_versions: 0,
      snapshots: 0,
      occurrences: 0,
      imports: 0,
    });
    await pool.query(`
      DROP TRIGGER fail_person_rehearsal_insert ON public.person_profiles;
      DROP FUNCTION public.fail_person_rehearsal_insert();
    `);

    const concurrentReports = await Promise.all([
      importPersonCohort(pool, decodedSnapshot),
      importPersonCohort(pool, decodedSnapshot),
    ]);
    assert.deepEqual(
      concurrentReports.map(({ replay }) => replay).sort(),
      [false, true],
      "Concurrent import did not serialize to one commit and one replay",
    );
    assert.equal(
      digest(concurrentReports[0]!.occurrences),
      digest(concurrentReports[1]!.occurrences),
      "Concurrent import reports diverged; details redacted",
    );
    const committedReport = concurrentReports.find(({ replay }) => !replay)!;
    assert.deepEqual(
      {
        input: committedReport.input,
        accepted: committedReport.accepted,
        quarantined: committedReport.quarantined,
        reasons: reasonCounts(committedReport),
      },
      {
        input: 2_923,
        accepted: 2_893,
        quarantined: 30,
        reasons: { CreatedPerson: 2_893, Inactive: 13, InvalidRow: 17 },
      },
      "Real Person cohort classification changed; aggregate details only",
    );
    assert.equal(
      digest(committedReport),
      expectedPersonReportFingerprint,
      "Real Person cohort dispositions changed; details redacted",
    );

    const replayReport = await importPersonCohort(pool, decodedSnapshot);
    assert.equal(replayReport.replay, true);
    assert.equal(
      digest(replayReport.occurrences),
      digest(committedReport.occurrences),
      "Replay report differs; details redacted",
    );

    const changed = structuredClone(decodedSnapshot) as PersonCohortSnapshot;
    const first = changed.occurrences[0]!;
    const changedRow = { ...(first.row as Record<string, unknown>), username: "changed-source" };
    const changedSnapshot = decodePersonCohort({
      ...changed,
      snapshotId: "vektor-backup-2024-08-22-changed",
      occurrences: [
        { ...first, row: changedRow, sourceRowDigest: personCohortSourceRowDigest(changedRow) },
        ...changed.occurrences.slice(1),
      ],
    });
    await expectFailure(importPersonCohort(pool, changedSnapshot), "SourceIdentityConflict");

    const countsBeforeBackup = await nativeCounts(pool);
    const stateFingerprintBeforeBackup = await nativeStateFingerprint(pool);
    const dumpPath = join(privateRoot, "person-native.dump");
    await run(
      [
        "pg_dump",
        "-Fc",
        "-h",
        postgresRoot,
        "-p",
        String(postgresPort),
        "-U",
        "postgres",
        "-d",
        nativeDatabase,
        "-f",
        dumpPath,
      ],
      { redactStderr: true },
    );
    await chmod(dumpPath, 0o600);
    await secureRegularFile(dumpPath, 0o600);
    await run([
      "createdb",
      "-h",
      postgresRoot,
      "-p",
      String(postgresPort),
      "-U",
      "postgres",
      restoredDatabase,
    ]);
    await run(
      [
        "pg_restore",
        "--exit-on-error",
        "-h",
        postgresRoot,
        "-p",
        String(postgresPort),
        "-U",
        "postgres",
        "-d",
        restoredDatabase,
        dumpPath,
      ],
      { redactStderr: true },
    );
    const restoredUrl = postgresUrl(postgresRoot, postgresPort, restoredDatabase);
    restoredPool = new Pool({ connectionString: restoredUrl, max: 2 });
    const countsAfterRestore = await nativeCounts(restoredPool);
    assert.deepEqual(countsAfterRestore, countsBeforeBackup, "Restored Person counts differ");
    assert.equal(
      await nativeStateFingerprint(restoredPool),
      stateFingerprintBeforeBackup,
      "Restored Person content differs",
    );
    const restoredReplay = await importPersonCohort(restoredPool, decodedSnapshot);
    assert.equal(restoredReplay.replay, true, "Restored source accepted another write");
    assert.equal(
      digest({ ...restoredReplay, replay: false }),
      digest(committedReport),
      "Restored Person report differs",
    );

    const acceptedOccurrence = committedReport.occurrences.find(
      ({ disposition }) => disposition === "Accepted",
    )!;
    const acceptedSourceId = acceptedOccurrence.occurrenceId.slice("legacy-user-row-".length);
    const acceptedPersonId = Schema.decodeSync(PersonId)("legacy-person-" + acceptedSourceId);
    const profile = await Effect.runPromise(
      readOwnProfile(acceptedPersonId).pipe(
        Effect.provide(
          DatabaseLive({
            url: Redacted.make(restoredUrl),
            applicationName: "legacy-backup-person-profile-read",
            maxConnections: 1,
          }),
        ),
      ),
    );
    assert.equal(profile.personId, acceptedPersonId);

    const aliasesDetected = users.filter(
      ({ username, companyEmail }) =>
        (typeof username === "string" && username !== "") ||
        (typeof companyEmail === "string" && companyEmail !== ""),
    ).length;
    const reasons = reasonCounts(committedReport);
    const cutoverDatabase = "legacy_service_cutover_rehearsal";
    await run(["createdb", "-h", postgresRoot, "-p", String(postgresPort),
      "-U", "postgres", cutoverDatabase]);
    const cutoverTargetUrl = postgresUrl(postgresRoot, postgresPort, cutoverDatabase);
    await migrateNativeDatabase(cutoverTargetUrl);
    const cutoverSourceUrl = new URL("mysql://legacy_cutover_reader@localhost/vektor");
    cutoverSourceUrl.searchParams.set("socketPath", mysqlSocket);
    const cutoverOptions = {
      sourceUrl: cutoverSourceUrl.toString(), targetUrl: cutoverTargetUrl,
      targetDatabase: cutoverDatabase, snapshotId: "vektor-backup-2024-08-22-service",
      attestedBy: "legacy-backup-2024-08-22",
    };
    const cutoverFirst = await runLegacyServiceCutover(cutoverOptions).catch(() => {
      throw new Error("Local service cutover failed; details redacted");
    });
    assert.deepEqual({
      departments: cutoverFirst.references.departments,
      semesters: cutoverFirst.references.semesters,
      schools: cutoverFirst.references.schools,
      relationships: cutoverFirst.references.relationships,
      historical: cutoverFirst.historicalService.input,
    }, { departments: 5, semesters: 28, schools: 44, relationships: 43, historical: 1815 });
    assert.equal(cutoverFirst.currentAssignments, "NotImported");
    const cutoverReplay = await runLegacyServiceCutover(cutoverOptions).catch(() => {
      throw new Error("Local service cutover replay failed; details redacted");
    });
    assert.equal(cutoverReplay.references.stage, "ExactReplay");
    assert.equal(cutoverReplay.person.stage, "ExactReplay");
    assert.deepEqual(cutoverReplay.historicalService, cutoverFirst.historicalService,
      "Historical service replay diverged; details redacted");
    completedReport = {
      specification: "legacy-backup-person-rehearsal",
      result: "passed",
      source: {
        sha256: sourceSha256,
        bytes: sourceBytes.byteLength,
        shape: {
          tables: toInt(shape.tables),
          columns: toInt(shape.columns),
          foreignKeys: toInt(shape.foreignKeys),
          appliedMigrations: toInt(shape.migrations),
          declaredMigrations: declaredMigrationIds.length,
          people: toInt(shape.people),
          activePeople: toInt(shape.activePeople),
        },
        classifications: {
          entityTables: entityTables.size,
          relationTables: relationTables.length,
          migrationTables: migrationTables.length,
        },
        schemaFingerprint: digest({ schemaRows, foreignKeyRows, representativeUserConstraints }),
        declaredMigrationFingerprint: digest(declaredMigrationIds),
        postBackupMigrationFingerprint: digest(postBackupMigrationIds),
      },
      cohort: {
        digest: cohortDigest,
        toolRevision,
        input: committedReport.input,
        accepted: committedReport.accepted,
        quarantined: committedReport.quarantined,
        reasons,
        aliasesDetected,
        aliases: committedReport.aliases,
        credentialsDetected: toInt(shape.credentials),
        credentials: committedReport.credentials,
      },
      native: {
        schemaRevision: databaseSchemaRevision,
        stateFingerprint: stateFingerprintBeforeBackup,
        reportFingerprint: digest(committedReport),
        counts: countsBeforeBackup,
      },
      cutoverRehearsal: cutoverFirst,
      gates: {
        postgresTransport: "owner-only-unix-socket",
        rollbackLeavesNoPartialWrites: "passed",
        concurrentImport: "one-commit-one-replay",
        exactReplay: "no-additional-writes",
        changedSource: "rejected",
        backupRestore: "equivalent",
        restoredReplay: "no-additional-writes",
        nativeOwnProfileRead: "passed",
        privateArtifacts: "owner-only-and-cleaned",
      },
      deferredCohorts: [
        "credential-and-account-recovery",
        "historical-affiliations",
        "current-school-placements",
        "receipt-and-private-files",
      ],
      productionResourcesUsed: false,
      externalProviderActions: false,
    } as const;
  } finally {
    let processCleanupFailed = false;
    const recordCleanupFailure = () => {
      cleanupFailed = true;
    };
    const recordProcessCleanupFailure = () => {
      cleanupFailed = true;
      processCleanupFailed = true;
    };
    if (restoredPool !== undefined) await restoredPool.end().catch(recordCleanupFailure);
    if (pool !== undefined) await pool.end().catch(recordCleanupFailure);
    if (postgresStarted) {
      await run(["pg_ctl", "-D", postgresRoot, "-m", "fast", "-t", "10", "-w", "stop"], {
        redactStderr: true,
      }).catch(recordCleanupFailure);
      const pidFileRemains = await lstat(join(postgresRoot, "postmaster.pid")).then(
        () => true,
        () => false,
      );
      if (pidFileRemains) recordProcessCleanupFailure();
    }
    await stopProcess(mysqlProcess).catch(recordProcessCleanupFailure);
    processCleanupComplete = !processCleanupFailed;
  }
  if (cleanupFailed) throw new Error("Rehearsal process cleanup failed; details redacted");
  assert.ok(completedReport !== undefined);
  return completedReport;
};

const temporaryRoot = await mkdtemp(join(tmpdir(), "vektor-legacy-person-rehearsal-"));
await chmod(temporaryRoot, 0o700);
let report: Awaited<ReturnType<typeof runRehearsal>> | undefined;
try {
  report = await runRehearsal(temporaryRoot);
} finally {
  if (processCleanupComplete) await rm(temporaryRoot, { recursive: true, force: true });
}
assert.ok(report !== undefined);
console.log(JSON.stringify(report, null, 2));
