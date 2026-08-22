import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const composeFile = join(repositoryRoot, "docker-compose.yml");
const dashboardOrigin = "http://127.0.0.1:5174";
const receiptApiOrigin = "http://127.0.0.1:8790";
const postgresUrl = "postgres://receipt:receipt@127.0.0.1:55432/receipt_proof";
const composeProject = `mono-web-receipt-0035-${process.pid}`;
const commandTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function assertPortAvailable(port) {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      rejectPort(new Error(`Loopback port ${port} is already in use`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error && typeof error === "object" && "code" in error && error.code === "ECONNREFUSED") {
        resolvePort();
        return;
      }
      rejectPort(new Error(`Could not inspect loopback port ${port}`));
    });
  });
}

function runCommand(command, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const captureOutput = options.captureOutput === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    const stdout = [];
    if (captureOutput) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.resume();
    }

    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs);
      hardKill.unref();
      if (!settled) {
        settled = true;
        rejectCommand(new Error(`${options.label} timed out`));
      }
    }, commandTimeoutMs);
    timeout.unref();

    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectCommand(new Error(`${options.label} could not start`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolveCommand(
          captureOutput ? { stdout: Buffer.concat(stdout).toString("utf8") } : undefined,
        );
        return;
      }
      rejectCommand(
        new Error(
          `${options.label} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}`,
        ),
      );
    });
  });
}

function startProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  child.once("error", () => undefined);
  return child;
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) {
    return;
  }

  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
      throw new Error("Could not stop local process group");
    }
    return;
  }

  const stopped = await Promise.race([
    exited.then(() => true),
    sleep(shutdownTimeoutMs).then(() => false),
  ]);
  if (stopped) return;

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
      throw new Error("Could not terminate local process group");
    }
  }
  await exited;
}

async function waitForHttp(url, child, label) {
  const deadline = Date.now() + commandTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before readiness`);
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // Readiness is retried until the bounded deadline.
    }
    await sleep(250);
  }
  throw new Error(`${label} did not become ready`);
}

async function waitForPostgres(environment) {
  const deadline = Date.now() + commandTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await runCommand(
        "docker",
        [
          "compose",
          "-f",
          composeFile,
          "-p",
          composeProject,
          "exec",
          "-T",
          "receipt-postgres",
          "pg_isready",
          "-U",
          "receipt",
          "-d",
          "receipt_proof",
        ],
        {
          cwd: repositoryRoot,
          env: environment,
          label: "Disposable PostgreSQL readiness check",
          captureOutput: true,
        },
      );
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready");
}

async function countFiles(root) {
  try {
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    return entries.reduce((count, entry) => count + (entry.isFile() ? 1 : 0), 0);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function readPostgresEvidence(environment) {
  const sql = `
    SELECT json_build_object(
      'receiptCount', (SELECT count(*) FROM economy_receipts),
      'commandCount', (SELECT count(*) FROM economy_receipt_command_receipts),
      'auditCount', (SELECT count(*) FROM economy_receipt_audit),
      'outboxCount', (SELECT count(*) FROM economy_receipt_outbox),
      'deliveredOutboxCount', (
        SELECT count(*) FROM economy_receipt_outbox WHERE status = 'Delivered'
      ),
      'duplicateEffectCount', (
        SELECT count(*) FROM (
          SELECT command_id, ordinal
          FROM economy_receipt_outbox
          GROUP BY command_id, ordinal
          HAVING count(*) > 1
        ) duplicate_effects
      )
    )::text;
  `;
  const result = await runCommand(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      "-p",
      composeProject,
      "exec",
      "-T",
      "receipt-postgres",
      "psql",
      "-U",
      "receipt",
      "-d",
      "receipt_proof",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Receipt persistence evidence query",
      captureOutput: true,
    },
  );
  return JSON.parse(result.stdout.trim());
}

function assertDurableEvidence(postgres, privateFile) {
  if (
    postgres.receiptCount !== 1 ||
    postgres.commandCount !== 1 ||
    postgres.auditCount !== 1 ||
    postgres.outboxCount < 1 ||
    postgres.deliveredOutboxCount !== postgres.outboxCount ||
    postgres.duplicateEffectCount !== 0
  ) {
    throw new Error("Receipt persistence evidence did not prove one durable replay-safe write");
  }
  if (privateFile.stagingFileCount !== 0 || privateFile.committedFileCount !== 1) {
    throw new Error("Receipt private-file evidence did not prove one committed file");
  }
}

async function main() {
  await Promise.all([
    assertPortAvailable(5174),
    assertPortAvailable(8790),
    assertPortAvailable(55432),
  ]);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-receipt-owner-0035-"));
  const stagingRoot = join(temporaryRoot, "staging");
  const committedRoot = join(temporaryRoot, "committed");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);

  const token = randomBytes(32).toString("base64url");
  const actorTokens = JSON.stringify({
    [token]: {
      personId: "assistant-1",
      departmentId: "department-1",
      active: true,
      paymentAccountCiphertext: randomBytes(32).toString("base64url"),
      approvalScope: { _tag: "None" },
    },
  });
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;

  const apiEnvironment = {
    ...baseEnvironment,
    RECEIPT_PG_URL: postgresUrl,
    RECEIPT_API_PORT: "8790",
    RECEIPT_STAGING_ROOT: stagingRoot,
    RECEIPT_COMMITTED_ROOT: committedRoot,
    RECEIPT_MAX_FILE_BYTES: "10485760",
    RECEIPT_AUTH_TOKENS: actorTokens,
  };
  const dashboardEnvironment = {
    ...baseEnvironment,
    API_URL: receiptApiOrigin,
    VITE_API_URL: receiptApiOrigin,
  };
  const playwrightEnvironment = {
    ...dashboardEnvironment,
    REAL_RECEIPT_OWNER_E2E: "1",
    RECEIPT_API_ORIGIN: receiptApiOrigin,
    DASHBOARD_ORIGIN: dashboardOrigin,
    RECEIPT_E2E_TOKEN: token,
  };

  let postgresStarted = false;
  let apiProcess;
  let dashboardProcess;
  let evidence;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const cleanupErrors = [];

    for (const processToStop of [dashboardProcess, apiProcess]) {
      try {
        await stopProcess(processToStop);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (postgresStarted) {
      try {
        await runCommand(
          "docker",
          [
            "compose",
            "-f",
            composeFile,
            "-p",
            composeProject,
            "down",
            "--volumes",
            "--remove-orphans",
          ],
          {
            cwd: repositoryRoot,
            env: baseEnvironment,
            label: "Disposable PostgreSQL cleanup",
          },
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Real Receipt owner topology cleanup failed");
    }
  };

  const handleSignal = (signal) => {
    void cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  const handleInterrupt = () => handleSignal("SIGINT");
  const handleTermination = () => handleSignal("SIGTERM");
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);

  let primaryError;
  try {
    await runCommand(
      "docker",
      ["compose", "-f", composeFile, "-p", composeProject, "up", "-d", "receipt-postgres"],
      {
        cwd: repositoryRoot,
        env: baseEnvironment,
        label: "Disposable PostgreSQL startup",
      },
    );
    postgresStarted = true;
    await waitForPostgres(baseEnvironment);

    const configuredApiCommand = process.env.RECEIPT_API_COMMAND;
    apiProcess = configuredApiCommand
      ? startProcess("/bin/sh", ["-c", configuredApiCommand], {
          cwd: repositoryRoot,
          env: apiEnvironment,
        })
      : startProcess("bun", ["run", "--cwd", "apps/receipt-api", "start"], {
          cwd: repositoryRoot,
          env: apiEnvironment,
        });
    await waitForHttp(`${receiptApiOrigin}/health`, apiProcess, "Native Receipt API");

    dashboardProcess = startProcess(
      "bun",
      ["run", "dev", "--host", "127.0.0.1", "--port", "5174"],
      {
        cwd: dashboardRoot,
        env: dashboardEnvironment,
      },
    );
    await waitForHttp(`${dashboardOrigin}/login`, dashboardProcess, "Dashboard");

    await runCommand(
      "node",
      [
        "./node_modules/@playwright/test/cli.js",
        "test",
        "e2e/receipts.spec.ts",
        "--project=receipt-owner",
        "--workers=1",
        "--retries=0",
      ],
      {
        cwd: dashboardRoot,
        env: playwrightEnvironment,
        label: "Real Receipt owner Playwright journey",
      },
    );

    const postgres = await readPostgresEvidence(baseEnvironment);
    const privateFile = {
      stagingFileCount: await countFiles(stagingRoot),
      committedFileCount: await countFiles(committedRoot),
    };
    assertDurableEvidence(postgres, privateFile);
    evidence = {
      topology: {
        dashboard: "loopback-react-router",
        api: "native-effect-receipt",
        database: "disposable-postgresql",
        privateFile: "disposable-filesystem",
      },
      postgres,
      privateFile,
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTermination);
  }

  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Real Receipt owner journey and cleanup failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;

  process.stdout.write(
    `${JSON.stringify({
      ...evidence,
      cleanup: {
        postgresRemoved: true,
        privateFilesystemRemoved: true,
      },
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Real Receipt owner runner failed"}\n`,
  );
  process.exitCode = 1;
});
