import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
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
const composeProject = `mono-web-receipt-0037-${process.pid}`;
const commandTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;
const postgresPort = 55432;
const nixPostgresPackage = "nixpkgs#postgresql_17";
const dockerAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const postgresTopology = dockerAvailable ? "docker" : "local";

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

function runNixPostgres(command, args, options) {
  return runCommand(
    "nix",
    ["shell", nixPostgresPackage, "--command", command, ...args],
    options,
  );
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
      const args =
        postgresTopology === "docker"
          ? [
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
            ]
          : ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "-d", "receipt_proof"];
      const options = {
        cwd: repositoryRoot,
        env: environment,
        label: "Disposable PostgreSQL readiness check",
        captureOutput: true,
      };
      if (postgresTopology === "docker") await runCommand("docker", args, options);
      else await runNixPostgres("pg_isready", args, options);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready");
}

async function startLocalPostgres(dataRoot, environment) {
  await rm(dataRoot, { recursive: true, force: true });
  await mkdir(dataRoot, { recursive: true });
  await runNixPostgres(
    "initdb",
    [
      "--pgdata",
      dataRoot,
      "--username=receipt",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-locale",
      "--encoding=UTF8",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local disposable PostgreSQL initialization",
    },
  );
  await runNixPostgres(
    "pg_ctl",
    [
      "-D",
      dataRoot,
      "-o",
      `-p ${postgresPort} -h 127.0.0.1`,
      "-l",
      join(dataRoot, "postgres.log"),
      "-w",
      "start",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local disposable PostgreSQL startup",
    },
  );
  await waitForPostgres(environment);
  await runNixPostgres(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local disposable PostgreSQL database creation",
    },
  );
}

async function stopLocalPostgres(dataRoot, environment) {
  await runNixPostgres("pg_ctl", ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    label: "Local disposable PostgreSQL cleanup",
  });
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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
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
      'pendingOutboxCount', (
        SELECT count(*) FROM economy_receipt_outbox WHERE status <> 'Delivered'
      ),
      'duplicateEffectCount', (
        SELECT count(*) FROM (
          SELECT command_id, ordinal
          FROM economy_receipt_outbox
          GROUP BY command_id, ordinal
          HAVING count(*) > 1
        ) duplicate_effects
      ),
      'receipts', (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'receiptId', receipt_id,
              'visualId', visual_id,
              'ownerPersonId', owner_person_id,
              'departmentId', department_id,
              'status', status,
              'revision', revision,
              'refundDate', CASE WHEN refund_date IS NULL THEN NULL
                ELSE to_char(refund_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              END,
              'fileRef', file_ref,
              'objectKey', file_object_key,
              'sha256', file_sha256
            )
            ORDER BY receipt_id
          ),
          '[]'::json
        )
        FROM economy_receipts
      ),
      'commands', (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'commandId', command_id,
              'receiptId', receipt_id
            )
            ORDER BY committed_at, command_id
          ),
          '[]'::json
        )
        FROM economy_receipt_command_receipts
      ),
      'audits', (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'commandId', command_id,
              'receiptId', receipt_id,
              'actorPersonId', actor_person_id,
              'action', action,
              'receiptRevision', receipt_revision
            )
            ORDER BY command_id
          ),
          '[]'::json
        )
        FROM economy_receipt_audit
      ),
      'outbox', (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'effectId', outbox.effect_id,
              'effectType', outbox.effect_type,
              'receiptId', outbox.receipt_id,
              'commandId', outbox.command_id,
              'ordinal', outbox.ordinal,
              'status', outbox.status
            )
            ORDER BY command_receipt.committed_at, outbox.command_id, outbox.ordinal
          ),
          '[]'::json
        )
        FROM economy_receipt_outbox AS outbox
        JOIN economy_receipt_command_receipts AS command_receipt
          ON command_receipt.command_id = outbox.command_id
      )
    )::text;
  `;
  const args =
    postgresTopology === "docker"
      ? [
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
        ]
      : [
          "-h",
          "127.0.0.1",
          "-p",
          String(postgresPort),
          "-U",
          "receipt",
          "-d",
          "receipt_proof",
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          sql,
        ];
  const options = {
    cwd: repositoryRoot,
    env: environment,
    label: "Receipt persistence evidence query",
    captureOutput: true,
  };
  const result =
    postgresTopology === "docker"
      ? await runCommand("docker", args, options)
      : await runNixPostgres("psql", args, options);
  return JSON.parse(result.stdout.trim());
}

function assertExpectedOutboxCommandOrder(postgres, journeyEvidence) {
  const expectedCommandOrder = [
    ...journeyEvidence.commands.submissions,
    journeyEvidence.commands.refund,
    journeyEvidence.commands.reject,
    journeyEvidence.commands.stale,
    journeyEvidence.commands.concurrentWinner,
  ];
  const observedCommandOrder = [];
  for (const row of postgres.outbox) {
    if (observedCommandOrder.at(-1) !== row.commandId) {
      observedCommandOrder.push(row.commandId);
    }
  }
  if (JSON.stringify(observedCommandOrder) !== JSON.stringify(expectedCommandOrder)) {
    throw new Error("Receipt approval outbox effects are not ordered by accepted command");
  }
}

function assertDurableEvidence(postgres, privateFile, journeyEvidence) {
  assertExpectedOutboxCommandOrder(postgres, journeyEvidence);
  if (
    postgres.receiptCount !== 4 ||
    postgres.commandCount !== 8 ||
    postgres.auditCount !== 8 ||
    postgres.outboxCount !== 20 ||
    postgres.deliveredOutboxCount !== 20 ||
    postgres.pendingOutboxCount !== 0 ||
    postgres.duplicateEffectCount !== 0
  ) {
    throw new Error("Receipt approval persistence counts did not prove exactly-once effects");
  }

  if (
    privateFile.stagingFileCount !== 0 ||
    privateFile.committedFileCount !== 4 ||
    JSON.stringify(journeyEvidence.fileIdentitiesBefore) !==
      JSON.stringify(journeyEvidence.fileIdentitiesAfter)
  ) {
    throw new Error("Receipt approval private-file identities changed during resolution");
  }
  const finalFileIdentities = postgres.receipts.map((receipt) => ({
    receiptId: receipt.receiptId,
    fileRef: receipt.fileRef,
    objectKey: receipt.objectKey,
    sha256: receipt.sha256,
  }));
  if (JSON.stringify(finalFileIdentities) !== JSON.stringify(journeyEvidence.fileIdentitiesAfter)) {
    throw new Error("Receipt approval durable file identities differ from journey evidence");
  }

  if (
    journeyEvidence.durablePostgresFailure?.status !== 503 ||
    journeyEvidence.durablePostgresFailure?.tag !== "ReceiptPersistenceError"
  ) {
    throw new Error("Receipt approval journey did not prove a typed PostgreSQL failure");
  }

  const expectedReceiptIds = Object.values(journeyEvidence.receipts);
  const receiptById = new Map(postgres.receipts.map((receipt) => [receipt.receiptId, receipt]));
  if (
    expectedReceiptIds.length !== 4 ||
    new Set(expectedReceiptIds).size !== 4 ||
    postgres.receipts.length !== expectedReceiptIds.length
  ) {
    throw new Error("Receipt approval durable receipt identity set is incomplete");
  }

  for (const receiptId of expectedReceiptIds) {
    const receipt = receiptById.get(receiptId);
    if (receipt === undefined || receipt.revision !== 1) {
      throw new Error(`Receipt ${receiptId} did not commit exactly one approval revision`);
    }
    if (
      (receipt.status === "Refunded" && typeof receipt.refundDate !== "string") ||
      (receipt.status !== "Refunded" && receipt.refundDate !== null)
    ) {
      throw new Error(`Receipt ${receiptId} violated the refund-date invariant`);
    }
  }

  const expectedCommandIds = [
    ...journeyEvidence.commands.submissions,
    journeyEvidence.commands.refund,
    journeyEvidence.commands.reject,
    journeyEvidence.commands.stale,
    journeyEvidence.commands.concurrentWinner,
  ];
  if (new Set(expectedCommandIds).size !== 8) {
    throw new Error("Receipt approval command IDs are not unique");
  }
  const commandIds = postgres.commands.map((command) => command.commandId);
  if (
    commandIds.length !== expectedCommandIds.length ||
    !expectedCommandIds.every((commandId) => commandIds.includes(commandId))
  ) {
    throw new Error("Rejected approval commands created durable command receipts");
  }

  const auditByCommand = new Map(postgres.audits.map((audit) => [audit.commandId, audit]));
  if (
    postgres.audits.some((audit) => !expectedCommandIds.includes(audit.commandId)) ||
    expectedCommandIds.some((commandId) => auditByCommand.get(commandId) === undefined)
  ) {
    throw new Error("Receipt approval audit rows do not match accepted commands");
  }
  for (const commandId of journeyEvidence.commands.submissions) {
    if (auditByCommand.get(commandId)?.action !== "ReceiptSubmitted") {
      throw new Error("Receipt submission audit action is incorrect");
    }
  }
  if (auditByCommand.get(journeyEvidence.commands.refund)?.action !== "ReceiptRefunded") {
    throw new Error("Receipt refund audit action is incorrect");
  }
  if (
    auditByCommand.get(journeyEvidence.commands.reject)?.action !== "ReceiptRejected" ||
    auditByCommand.get(journeyEvidence.commands.stale)?.action !== "ReceiptRejected"
  ) {
    throw new Error("Receipt rejection audit action is incorrect");
  }
  const concurrentReceipt = receiptById.get(journeyEvidence.receipts.concurrent);
  const expectedConcurrentAction =
    concurrentReceipt?.status === "Refunded" ? "ReceiptRefunded" : "ReceiptRejected";
  if (auditByCommand.get(journeyEvidence.commands.concurrentWinner)?.action !== expectedConcurrentAction) {
    throw new Error("Concurrent approval audit action is incorrect");
  }

  const outboxByCommand = new Map();
  for (const row of postgres.outbox) {
    const rows = outboxByCommand.get(row.commandId) ?? [];
    rows.push(row);
    outboxByCommand.set(row.commandId, rows);
    if (row.status !== "Delivered") throw new Error("Receipt approval outbox is not fully delivered");
  }
  const expectedSubmissionEffects = [
    "PromoteReceiptFile",
    "NotifyEconomyReceiptSubmitted",
    "WriteReceiptAudit",
  ];
  for (const commandId of journeyEvidence.commands.submissions) {
    const rows = outboxByCommand.get(commandId)?.sort((left, right) => left.ordinal - right.ordinal);
    if (
      rows === undefined ||
      rows.length !== expectedSubmissionEffects.length ||
      rows.some((row, ordinal) => row.ordinal !== ordinal || row.effectType !== expectedSubmissionEffects[ordinal])
    ) {
      throw new Error("Receipt submission outbox order is incorrect");
    }
  }
  const expectedResolutionEffects = new Map([
    [journeyEvidence.commands.refund, "NotifyReceiptRefunded"],
    [journeyEvidence.commands.reject, "NotifyReceiptRejected"],
    [journeyEvidence.commands.stale, "NotifyReceiptRejected"],
    [
      journeyEvidence.commands.concurrentWinner,
      expectedConcurrentAction === "ReceiptRefunded" ? "NotifyReceiptRefunded" : "NotifyReceiptRejected",
    ],
  ]);
  for (const [commandId, notificationEffect] of expectedResolutionEffects) {
    const rows = outboxByCommand.get(commandId)?.sort((left, right) => left.ordinal - right.ordinal);
    if (
      rows === undefined ||
      rows.length !== 2 ||
      rows[0]?.ordinal !== 0 ||
      rows[0]?.effectType !== notificationEffect ||
      rows[1]?.ordinal !== 1 ||
      rows[1]?.effectType !== "WriteReceiptAudit"
    ) {
      throw new Error("Receipt approval outbox order is incorrect");
    }
  }
}

async function main() {
  await Promise.all([
    assertPortAvailable(5174),
    assertPortAvailable(8790),
    assertPortAvailable(55432),
  ]);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-receipt-approval-0037-"));
  const stagingRoot = join(temporaryRoot, "staging");
  const committedRoot = join(temporaryRoot, "committed");
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const approvalEvidencePath = join(temporaryRoot, "approval-evidence.json");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);

  const tokens = {
    ownerA: randomBytes(32).toString("base64url"),
    ownerB: randomBytes(32).toString("base64url"),
    departmentA: randomBytes(32).toString("base64url"),
    departmentB: randomBytes(32).toString("base64url"),
    global: randomBytes(32).toString("base64url"),
    inactive: randomBytes(32).toString("base64url"),
    noneScope: randomBytes(32).toString("base64url"),
  };
  const principal = (personId, departmentId, active, approvalScope) => ({
    personId,
    departmentId,
    active,
    paymentAccountCiphertext: randomBytes(32).toString("base64url"),
    approvalScope,
  });
  const actorTokens = JSON.stringify({
    [tokens.ownerA]: principal("owner-a", "department-a", true, { _tag: "None" }),
    [tokens.ownerB]: principal("owner-b", "department-b", true, { _tag: "None" }),
    [tokens.departmentA]: principal("approver-a", "department-a", true, {
      _tag: "Department",
      departmentId: "department-a",
    }),
    [tokens.departmentB]: principal("approver-b", "department-b", true, {
      _tag: "Department",
      departmentId: "department-b",
    }),
    [tokens.global]: principal("approver-global", "department-global", true, { _tag: "Global" }),
    [tokens.inactive]: principal("approver-inactive", "department-a", false, {
      _tag: "Department",
      departmentId: "department-a",
    }),
    [tokens.noneScope]: principal("approver-none", "department-a", true, { _tag: "None" }),
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
    REAL_RECEIPT_APPROVAL_E2E: "1",
    RECEIPT_API_ORIGIN: receiptApiOrigin,
    DASHBOARD_ORIGIN: dashboardOrigin,
    RECEIPT_COMPOSE_FILE: composeFile,
    RECEIPT_COMPOSE_PROJECT: composeProject,
    RECEIPT_POSTGRES_TOPOLOGY: postgresTopology,
    RECEIPT_POSTGRES_PACKAGE: nixPostgresPackage,
    RECEIPT_PG_DATA_ROOT: postgresDataRoot,
    RECEIPT_PG_PORT: String(postgresPort),
    RECEIPT_APPROVAL_EVIDENCE_FILE: approvalEvidencePath,
    RECEIPT_E2E_TOKEN: tokens.ownerA,
    RECEIPT_E2E_FOREIGN_TOKEN: tokens.ownerB,
    RECEIPT_APPROVAL_E2E_OWNER_A_TOKEN: tokens.ownerA,
    RECEIPT_APPROVAL_E2E_OWNER_B_TOKEN: tokens.ownerB,
    RECEIPT_APPROVAL_E2E_DEPARTMENT_A_TOKEN: tokens.departmentA,
    RECEIPT_APPROVAL_E2E_DEPARTMENT_B_TOKEN: tokens.departmentB,
    RECEIPT_APPROVAL_E2E_GLOBAL_TOKEN: tokens.global,
    RECEIPT_APPROVAL_E2E_INACTIVE_TOKEN: tokens.inactive,
    RECEIPT_APPROVAL_E2E_NONE_SCOPE_TOKEN: tokens.noneScope,
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
        if (postgresTopology === "docker") {
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
        } else {
          await stopLocalPostgres(postgresDataRoot, baseEnvironment);
        }
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
      throw new AggregateError(cleanupErrors, "Real Receipt approval topology cleanup failed");
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
    if (postgresTopology === "docker") {
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
    } else {
      postgresStarted = true;
      await startLocalPostgres(postgresDataRoot, baseEnvironment);
    }

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
        "e2e/receipt-approval.spec.ts",
        "--project=receipt-owner",
        "--workers=1",
        "--retries=0",
      ],
      {
        cwd: dashboardRoot,
        env: playwrightEnvironment,
        label: "Real Receipt approval Playwright journey",
      },
    );

    const journeyEvidence = JSON.parse(await readFile(approvalEvidencePath, "utf8"));
    const postgres = await readPostgresEvidence(baseEnvironment);
    const privateFile = {
      stagingFileCount: await countFiles(stagingRoot),
      committedFileCount: await countFiles(committedRoot),
    };
    assertDurableEvidence(postgres, privateFile, journeyEvidence);
    evidence = {
      topology: {
        dashboard: "loopback-react-router",
        api: "native-effect-receipt",
        database:
          postgresTopology === "docker"
            ? "disposable-postgresql-docker"
            : "disposable-postgresql-local-nix",
        privateFile: "disposable-filesystem",
      },
      postgres,
      privateFile,
      journey: journeyEvidence,
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
      "Real Receipt approval journey and cleanup failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;

  if (await pathExists(temporaryRoot)) {
    throw new Error("Real Receipt approval cleanup left the private temporary root behind");
  }

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
    `${error instanceof Error ? error.message : "Real Receipt approval runner failed"}\n`,
  );
  process.exitCode = 1;
});
