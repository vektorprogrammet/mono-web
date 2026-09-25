import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { postgresProgram } from "@monoweb/postgres";
import { databaseHealth } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { Effect, flow, Predicate, Redacted, Schema } from "effect";
import { Pool } from "pg";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const digest = flow(canonicalJsonBytes, sha256Hex);

// The current-assignment rehearsal's bounded subprocess and private-socket lifecycle.
// This helper is proof-local: it does not connect to supplied databases or run migrations itself.
export interface LocalCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const runLocalResult = async (
  command: ReadonlyArray<string>,
  stdin?: string,
  environment?: Record<string, string>,
): Promise<LocalCommandResult> => {
  const child = spawn(command[0]!, command.slice(1), {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
  const { promise, resolve: resolveExit, reject } = Promise.withResolvers<number>();
  child.once("error", () => reject(new Error("Local command unavailable; details redacted")));
  child.once("close", (status) => resolveExit(status ?? 1));
  const code = await promise;

  return {
    code,
    stdout: Buffer.concat(chunks).toString("utf8").trim(),
    stderr: Buffer.concat(errors).toString("utf8").trim(),
  };
};

export const runLocal = async (
  command: ReadonlyArray<string>,
  stdin?: string,
  environment?: Record<string, string>,
): Promise<string> => {
  const result = await runLocalResult(command, stdin, environment);
  assert.equal(result.code, 0, "Local command failed; details redacted");

  return result.stdout;
};

const waitForExit = (child: ChildProcess, milliseconds: number): Promise<boolean> => {
  const { promise, resolve: resolveExit } = Promise.withResolvers<boolean>();
  let settled = false;

  const finish = (hasExited: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    child.removeListener("exit", exited);
    resolveExit(hasExited);
  };

  const exited = () => finish(true);
  const timeout = setTimeout(() => finish(false), milliseconds);
  child.once("exit", exited);

  if (child.exitCode !== null || child.signalCode !== null) finish(true);

  return promise;
};

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");

  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");

  if (await waitForExit(child, 5_000)) return;
  throw new Error("Disposable MariaDB process remains");
};

export const targetFingerprint = async (pool: Pool): Promise<string> => {
  const tables = (
    await pool.query<{ name: string }>(`
    SELECT format('%I.%I',schemaname,tablename) AS name FROM pg_tables
    WHERE schemaname IN ('public','auth') ORDER BY schemaname,tablename
  `)
  ).rows;

  const facts: Record<string, Schema.Json> = {};

  for (const { name } of tables) {
    const result = await pool.query<{ rows: unknown }>(`
      SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY to_jsonb(value)::text),'[]'::jsonb) AS rows
      FROM ${name} value
    `);

    facts[name] = Schema.decodeUnknownSync(Schema.Json)(result.rows[0]!.rows);
  }

  return digest(facts);
};

export interface RehearsalTarget {
  readonly pool: Pool;
  readonly url: string;
  readonly database: string;
}

interface OrganizationDatabases {
  readonly temporaryRoot: string;
  readonly sourceUrl: string;
  readonly mysql: (sql: string) => Promise<string>;
  readonly target: (database: string) => Promise<RehearsalTarget>;
}

export const withOrganizationDatabases = async <A>(
  fixtureSql: string,
  use: (databases: OrganizationDatabases) => Promise<A>,
): Promise<A> => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vektor-org-"));
  await chmod(temporaryRoot, 0o700);
  const mysqlRoot = join(temporaryRoot, "mysql");
  const postgresRoot = join(temporaryRoot, "postgres");
  const mysqlData = join(mysqlRoot, "data");
  const mysqlSocket = join(mysqlRoot, "mysql.sock");
  let mysqlProcess: ChildProcess | undefined;
  let postgresStarted = false;
  let stopped = true;
  const pools: Pool[] = [];

  const mysql = (sql: string) =>
    runLocal(
      [
        "mariadb",
        "--no-defaults",
        "--batch",
        "--raw",
        "--skip-column-names",
        "--socket",
        mysqlSocket,
        "-uroot",
      ],
      sql,
    );

  const target = async (database: string): Promise<RehearsalTarget> => {
    await runLocal([
      postgresProgram("createdb"),
      "-h",
      postgresRoot,
      "-p",
      "5432",
      "-U",
      "postgres",
      database,
    ]);
    const selection = new URL(`postgresql://postgres@localhost/${database}`);
    selection.searchParams.set("host", postgresRoot);
    selection.searchParams.set("port", "5432");
    const url = selection.toString();
    await Effect.runPromise(
      databaseHealth.pipe(
        Effect.provide(
          DatabaseLive({
            url: Redacted.make(url),
            applicationName: "synthetic-organization-rehearsal",
            maxConnections: 2,
          }),
        ),
      ),
    );
    const pool = new Pool({ connectionString: url, max: 3 });
    pools.push(pool);

    return { pool, url, database };
  };

  const outcome = await (async () => {
    await mkdir(mysqlRoot, { mode: 0o700 });
    await mkdir(postgresRoot, { mode: 0o700 });
    await mkdir(mysqlData, { mode: 0o700 });
    await runLocal([
      "mariadb-install-db",
      "--no-defaults",
      `--datadir=${mysqlData}`,
      "--auth-root-authentication-method=normal",
      "--skip-test-db",
    ]);
    mysqlProcess = spawn(
      "mariadbd",
      [
        "--no-defaults",
        `--datadir=${mysqlData}`,
        `--socket=${mysqlSocket}`,
        `--pid-file=${join(mysqlRoot, "mysql.pid")}`,
        `--log-error=${join(mysqlRoot, "mysql.log")}`,
        "--skip-networking",
      ],
      { cwd: repositoryRoot, stdio: "ignore" },
    );
    mysqlProcess.once("error", () => undefined);
    const deadline = Date.now() + 30_000;

    while (true) {
      try {
        await mysql("SELECT 1");
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error("Disposable MariaDB did not become ready");
        await delay(100);
      }
    }

    await mysql(fixtureSql);
    await runLocal([
      postgresProgram("initdb"),
      "-D",
      postgresRoot,
      "-A",
      "trust",
      "-U",
      "postgres",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    postgresStarted = true;
    await runLocal([
      postgresProgram("pg_ctl"),
      "-D",
      postgresRoot,
      "-l",
      join(postgresRoot, "postgres.log"),
      "-o",
      `-c listen_addresses= -k ${postgresRoot} -p 5432`,
      "-w",
      "start",
    ]);
    const sourceUrl = new URL("mysql://legacy_organization_reader@localhost/vektor");
    sourceUrl.searchParams.set("socketPath", mysqlSocket);

    return use({ temporaryRoot, sourceUrl: sourceUrl.toString(), mysql, target });
  })().then(
    (report) => ({ _tag: "Success" as const, report }),
    (error) => ({ _tag: "Failure" as const, error }),
  );

  const cleanupErrors: Error[] = [];

  for (const pool of pools)
    await pool.end().catch((cause) => {
      cleanupErrors.push(new Error("Disposable pool cleanup failed", { cause }));
    });

  if (postgresStarted) {
    await runLocal([
      postgresProgram("pg_ctl"),
      "-D",
      postgresRoot,
      "-m",
      "fast",
      "-t",
      "10",
      "-w",
      "stop",
    ]).catch((cause) => cleanupErrors.push(new Error("PostgreSQL cleanup failed", { cause })));

    if (
      await lstat(join(postgresRoot, "postmaster.pid")).then(
        () => true,
        () => false,
      )
    ) {
      stopped = false;
      cleanupErrors.push(new Error("Disposable PostgreSQL process remains"));
    }
  }

  if (mysqlProcess)
    await stop(mysqlProcess).catch((cause) => {
      stopped = false;
      cleanupErrors.push(new Error("MariaDB cleanup failed", { cause }));
    });

  if (stopped)
    await rm(temporaryRoot, { recursive: true, force: true }).catch((cause) => {
      cleanupErrors.push(new Error("Private directory cleanup failed", { cause }));
    });

  // Never replace the original assertion/transaction failure with a cleanup exception.
  if (Predicate.isTagged(outcome, "Failure"))
    throw new AggregateError(
      [outcome.error, ...cleanupErrors],
      "Synthetic organization rehearsal failed; details redacted",
    );

  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Owned runtime cleanup failed");

  return outcome.report;
};
