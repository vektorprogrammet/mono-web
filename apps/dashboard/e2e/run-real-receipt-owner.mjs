import {
  postgresComposeEnvironment,
  postgresComposeFile,
  postgresProgram,
} from "@monoweb/postgres";
import { ReadReceiptEvidenceEndpoint } from "@vektorprogrammet/http-api";
import { Predicate } from "effect";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { reserveLoopbackPorts } from "../../../tools/e2e/golden-harness.ts";
import { localBackendEnvironment } from "../../../tools/e2e/local-backend-environment.ts";
import { startReceiptDeliverySink } from "../../../tools/e2e/receipt-delivery-sink.ts";
import { deriveHttpIdentity } from "@vektorprogrammet/backend/http-semantics";
import { dashboardMount } from "../dashboard-base.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));

const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));

const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));

const disposablePorts = await reserveLoopbackPorts(4);

const [dashboardPort, backendPort, internalBackendPort, postgresPort] = disposablePorts;

/** The Idempotency-Key of the replacement revision whose file promotion the journey fails. */
const replacementIdempotencyKey = "receipt-owner-e2e-replacement";

const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

const backendOrigin = `http://127.0.0.1:${backendPort}`;

const internalBackendOrigin = `http://127.0.0.1:${internalBackendPort}`;

const postgresUrl = `postgres://receipt:receipt@127.0.0.1:${postgresPort}/receipt_proof?connect_timeout=1`;

const composeProject = `mono-web-receipt-0036-${process.pid}`;

const commandTimeoutMs = 300_000;

const shutdownTimeoutMs = 5_000;

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

      if (error && (error === null || Predicate.isObjectOrArray(error)) && "code" in error && error.code === "ECONNREFUSED") {
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
    if (!error || !(error === null || Predicate.isObjectOrArray(error)) || !("code" in error) || error.code !== "ESRCH") {
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
    if (!error || !(error === null || Predicate.isObjectOrArray(error)) || !("code" in error) || error.code !== "ESRCH") {
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
              postgresComposeFile,
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
      else await runCommand(postgresProgram("pg_isready"), args, options);

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
  await runCommand(
    postgresProgram("initdb"),
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
  await runCommand(
    postgresProgram("pg_ctl"),
    [
      "-D",
      dataRoot,
      "-o",
      `-p ${postgresPort} -h 127.0.0.1 -k ${dataRoot}`,
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
  await runCommand(
    postgresProgram("createdb"),
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local disposable PostgreSQL database creation",
    },
  );
}

async function stopLocalPostgres(dataRoot, environment) {
  await runCommand(postgresProgram("pg_ctl"), ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
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
    if (error && (error === null || Predicate.isObjectOrArray(error)) && "code" in error && error.code === "ENOENT") {
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
    if (error && (error === null || Predicate.isObjectOrArray(error)) && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function postgresSqlArgs(sql, tuplesOnly) {
  const formatArguments = tuplesOnly ? ["-At"] : [];

  return postgresTopology === "docker"
    ? [
        "compose",
        "-f",
        postgresComposeFile,
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
        ...formatArguments,
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
        ...formatArguments,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ];
}

async function runPostgresSql(sql, environment, label, captureOutput = false) {
  const args = postgresSqlArgs(sql, captureOutput);

  const options = {
    cwd: repositoryRoot,
    env: environment,
    label,
    captureOutput,
  };

  return postgresTopology === "docker"
    ? runCommand("docker", args, options)
    : runCommand(postgresProgram("psql"), args, options);
}

async function seedOwnerAuthorities(environment) {
  await runPostgresSql(
    `
      BEGIN;
      INSERT INTO organization_departments (
        department_id, name, short_name, email, city, active, revision
      ) VALUES (
        'department-1', 'Receiptavdeling', 'R1',
        'receipt.0036@example.invalid', 'Trondheim', TRUE, 0
      );
      INSERT INTO organization_teams (
        team_id, department_id, name, active, revision
      ) VALUES (
        'receipt-owner-team-0036', 'department-1', 'Receiptteam', TRUE, 0
      );
      INSERT INTO person_contact_profiles (person_id, email, phone, revision) VALUES
        ('assistant-1', 'owner.receipt.0036@example.invalid', '+47 900 36 001', 0),
        ('assistant-2', 'foreign-owner.receipt.0036@example.invalid', '+47 900 36 002', 0);
      INSERT INTO organization_memberships (
        membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
        position_id, is_team_leader, is_suspended, revision
      ) VALUES
        (
          'receipt-owner-membership-0036', 'assistant-1', 'receipt-owner-team-0036',
          NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0
        ),
        (
          'receipt-foreign-membership-0036', 'assistant-2', 'receipt-owner-team-0036',
          NULL, '2020-01-01T00:00:00Z', NULL, 'member', FALSE, FALSE, 0
        );
      INSERT INTO economy_payment_authorities (
        payment_authority_id, person_id, department_id, payment_account_ciphertext,
        start_at, end_at, revision
      ) VALUES
        (
          'receipt-owner-payment-0036', 'assistant-1', 'department-1',
          'ciphertext-owner-0036', '2020-01-01T00:00:00Z', NULL, 0
        ),
        (
          'receipt-foreign-payment-0036', 'assistant-2', 'department-1',
          'ciphertext-foreign-owner-0036', '2020-01-01T00:00:00Z', NULL, 0
        );
      COMMIT;
    `,
    environment,
    "Native Receipt owner authority seed",
  );
}

async function readPostgresEvidence(environment) {
  const sql = `
    SELECT json_build_object(
      'receiptId', (SELECT receipt_id FROM economy_receipts LIMIT 1),
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
      ),
      'finalStatus', (SELECT status FROM economy_receipts LIMIT 1),
      'finalRevision', (SELECT revision FROM economy_receipts LIMIT 1),
      'receiptFile', (
        SELECT json_build_object(
          'fileRef', file_ref,
          'objectKey', file_object_key,
          'contentType', file_content_type,
          'byteLength', file_byte_length,
          'sha256', file_sha256
        )
        FROM economy_receipts
        LIMIT 1
      ),
      'outbox', COALESCE((
        SELECT json_agg(
          json_build_object(
            'effectId', effect_id,
            'effectType', effect_type,
            'commandId', command_id,
            'receiptId', receipt_id,
            'ordinal', ordinal,
            'status', status,
            'attempts', attempts,
            'lastFailureTag', last_failure_tag
          )
          ORDER BY receipt_id, command_id, ordinal
        )
        FROM economy_receipt_outbox
      ), '[]'::json),
      'audits', COALESCE((
        SELECT json_agg(
          json_build_object(
            'commandId', command_id,
            'receiptId', receipt_id,
            'action', action,
            'receiptRevision', receipt_revision
          )
          ORDER BY occurred_at, command_id
        )
        FROM economy_receipt_audit
      ), '[]'::json)
    )::text;
  `;

  const result = await runPostgresSql(sql, environment, "Receipt persistence evidence query", true);

  return JSON.parse(result.stdout.trim());
}

/**
 * The backend derives a command id from the caller, operation, target, and Idempotency-Key,
 * so the replacement's effects are found by the id it derives for the owner's revision.
 */
const replacementCommandId = (postgres, ownerPersonId) =>
  deriveHttpIdentity({
    credentialSubject: `Person:${ownerPersonId}`,
    qualifiedOperationId: "receipts.reviseReceipt",
    normalizedTarget: `/api/receipts/${encodeURIComponent(postgres.receiptId)}`,
    idempotencyKey: replacementIdempotencyKey,
  }).commandId;

function assertDurableEvidence(postgres, privateFile, lifecycle, ownerPersonId) {
  const outbox = Array.isArray(postgres.outbox) ? postgres.outbox : [];
  const audits = Array.isArray(postgres.audits) ? postgres.audits : [];
  const replacementCommand = replacementCommandId(postgres, ownerPersonId);

  const replacementPromote = outbox.find(
    (row) => row.effectId === `${replacementCommand}:PromoteReceiptFile`,
  );

  const replacementDelete = outbox.find(
    (row) => row.effectId === `${replacementCommand}:DeleteReceiptFile`,
  );

  const replacementAudit = audits.find((row) => row.commandId === replacementCommand);
  const beforeFailure = lifecycle?.beforeFailure;
  const afterRetry = lifecycle?.afterRetry;

  // Each law is a named fact, so a failure reports which one broke instead of only that one did.
  const observed = {
    receiptCount: postgres.receiptCount,
    commandCount: postgres.commandCount,
    auditCount: postgres.auditCount,
    outboxCount: postgres.outboxCount,
    everyEffectDelivered: postgres.deliveredOutboxCount === postgres.outboxCount,
    duplicateEffectCount: postgres.duplicateEffectCount,
    finalStatus: postgres.finalStatus,
    finalRevision: postgres.finalRevision,
    replacementPromote: replacementPromote && {
      status: replacementPromote.status,
      attempts: replacementPromote.attempts,
      ordinal: replacementPromote.ordinal,
    },
    replacementDelete: replacementDelete && {
      status: replacementDelete.status,
      ordinal: replacementDelete.ordinal,
    },
    replacementAuditAction: replacementAudit?.action,
    retryKeptObjectKey:
      beforeFailure !== undefined &&
      afterRetry !== undefined &&
      beforeFailure.file.objectKey === afterRetry.file.objectKey,
    receiptKeepsRetriedFile: afterRetry?.file.objectKey === postgres.receiptFile?.objectKey,
    failureLeftFileUnpromoted:
      beforeFailure !== undefined &&
      beforeFailure.physical.committed.length > 0 &&
      !beforeFailure.physical.committed.includes(beforeFailure.file.objectKey),
    retryPromotedFile:
      afterRetry !== undefined && afterRetry.physical.committed.includes(afterRetry.file.objectKey),
  };

  const expected = {
    receiptCount: 1,
    commandCount: 5,
    auditCount: 5,
    outboxCount: 10,
    everyEffectDelivered: true,
    duplicateEffectCount: 0,
    finalStatus: "Withdrawn",
    finalRevision: 4,
    replacementPromote: { status: "Delivered", attempts: 2, ordinal: 0 },
    replacementDelete: { status: "Delivered", ordinal: 2 },
    replacementAuditAction: "PendingReceiptRevised",
    retryKeptObjectKey: true,
    receiptKeepsRetriedFile: true,
    failureLeftFileUnpromoted: true,
    retryPromotedFile: true,
  };

  if (!isDeepStrictEqual(observed, expected)) {
    const effects = outbox.map((row) => ({
      effectId: row.effectId,
      effectType: row.effectType,
      ordinal: row.ordinal,
      status: row.status,
      attempts: row.attempts,
      lastFailureTag: row.lastFailureTag,
    }));

    throw new Error(
      `Receipt persistence evidence did not prove injected replacement recovery: ${JSON.stringify({ observed, expected, effects })}`,
    );
  }

  if (privateFile.stagingFileCount !== 0 || privateFile.committedFileCount !== 0) {
    throw new Error("Receipt private-file evidence did not prove terminal file deletion");
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-receipt-owner-0036-"));
  const stagingRoot = join(temporaryRoot, "staging");
  const committedRoot = join(temporaryRoot, "committed");
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const lifecycleEvidencePath = join(temporaryRoot, "receipt-lifecycle-evidence.json");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);

  const betterAuthSecret = randomBytes(32).toString("base64url");
  const personaPassword = "receipt-owner-0036-password";

  const ownerPersona = {
    personId: "assistant-1",
    firstName: "Receipt",
    lastName: "Owner",
    email: "owner.receipt.0036@example.invalid",
    password: personaPassword,
  };

  const foreignPersona = {
    personId: "assistant-2",
    firstName: "Foreign",
    lastName: "Owner",
    email: "foreign-owner.receipt.0036@example.invalid",
    password: personaPassword,
  };

  const baseEnvironment = postgresComposeEnvironment({
    ...process.env,
    RECEIPT_APPROVAL_PG_PORT: String(postgresPort),
  });

  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;

  for (const name of [
    "ADMISSION_AUTH_TOKENS",
    "RECEIPT_AUTH_TOKENS",
    "RECEIPT_E2E_TOKEN",
    "RECEIPT_E2E_FOREIGN_TOKEN",
  ]) {
    delete baseEnvironment[name];
  }

  const sharedEnvironment = {
    ...baseEnvironment,
    BETTER_AUTH_SECRET: betterAuthSecret,
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
  };

  // The submission notifies the owner's department economy; without a delivery target that
  // effect keeps failing and holds every later effect of the receipt.
  const deliverySink = await startReceiptDeliverySink({
    sender: "economy@example.invalid",
    economyRecipients: { "department-1": "economy.department-1@example.invalid" },
  });

  const apiEnvironment = {
    ...sharedEnvironment,
    ...localBackendEnvironment({ backendOrigin, dashboardOrigin, postgresUrl, betterAuthSecret }),
    ...deliverySink.environment,
    RECEIPT_STAGING_ROOT: stagingRoot,
    RECEIPT_COMMITTED_ROOT: committedRoot,
    RECEIPT_MAX_FILE_BYTES: "10485760",
    RECEIPT_E2E_TEST_MODE: "1",
  };

  const internalApiEnvironment = {
    ...apiEnvironment,
    BACKEND_INGRESS: "internal",
    BACKEND_PORT: String(internalBackendPort),
    // Internal ingress requires its source networks; this runner reaches it over loopback only.
    OAUTH_INTERNAL_SOURCE_NETWORKS: "127.0.0.1/32",
  };

  const dashboardEnvironment = {
    ...sharedEnvironment,
    API_URL: backendOrigin,
    VITE_API_URL: backendOrigin,
    HOST: "127.0.0.1",
    PORT: String(dashboardPort),
  };

  const dashboardLoginUrl = new URL(
    `${dashboardMount(dashboardEnvironment)}login`,
    dashboardOrigin,
  ).toString();

  const playwrightEnvironment = {
    ...dashboardEnvironment,
    REAL_RECEIPT_OWNER_E2E: "1",
    RECEIPT_E2E_REPLACEMENT_IDEMPOTENCY_KEY: replacementIdempotencyKey,
    BACKEND_ORIGIN: backendOrigin,
    INTERNAL_BACKEND_ORIGIN: internalBackendOrigin,
    DASHBOARD_ORIGIN: dashboardOrigin,
    RECEIPT_E2E_OWNER_EMAIL: ownerPersona.email,
    RECEIPT_E2E_OWNER_PASSWORD: ownerPersona.password,
    RECEIPT_E2E_OWNER_PERSON_ID: ownerPersona.personId,
    RECEIPT_E2E_FOREIGN_EMAIL: foreignPersona.email,
    RECEIPT_E2E_FOREIGN_PASSWORD: foreignPersona.password,
    RECEIPT_E2E_FOREIGN_PERSON_ID: foreignPersona.personId,
    RECEIPT_E2E_STAGING_ROOT: stagingRoot,
    RECEIPT_E2E_COMMITTED_ROOT: committedRoot,
    RECEIPT_POSTGRES_TOPOLOGY: postgresTopology,
    RECEIPT_PG_DATA_ROOT: postgresDataRoot,
    RECEIPT_PG_PORT: String(postgresPort),
    RECEIPT_E2E_LIFECYCLE_EVIDENCE_PATH: lifecycleEvidencePath,
  };

  let postgresStarted = false;
  let apiProcess;
  let internalApiProcess;
  let dashboardProcess;
  let evidence;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const cleanupErrors = [];

    for (const processToStop of [dashboardProcess, internalApiProcess, apiProcess]) {
      try {
        await stopProcess(processToStop);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      await deliverySink.close();
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (postgresStarted) {
      try {
        if (postgresTopology === "docker") {
          await runCommand(
            "docker",
            [
              "compose",
              "-f",
              postgresComposeFile,
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
        } else if (await pathExists(join(postgresDataRoot, "postmaster.pid"))) {
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
    postgresStarted = true;

    if (postgresTopology === "docker") {
      await runCommand(
        "docker",
        [
          "compose",
          "-f",
          postgresComposeFile,
          "-p",
          composeProject,
          "up",
          "-d",
          "receipt-postgres",
        ],
        {
          cwd: repositoryRoot,
          env: baseEnvironment,
          label: "Disposable PostgreSQL startup",
        },
      );
      await waitForPostgres(baseEnvironment);
    } else {
      await startLocalPostgres(postgresDataRoot, baseEnvironment);
    }

    await runCommand("bun", ["run", "identity:seed"], {
      cwd: databaseRoot,
      env: {
        ...sharedEnvironment,
        IDENTITY_SEED_PG_URL: postgresUrl,
        IDENTITY_SEED_PERSONS: JSON.stringify([ownerPersona, foreignPersona]),
      },
      label: "Native Receipt owner identity seed",
    });
    await seedOwnerAuthorities(sharedEnvironment);

    const configuredBackendCommand = process.env.BACKEND_COMMAND;
    apiProcess = configuredBackendCommand
      ? startProcess("/bin/sh", ["-c", configuredBackendCommand], {
          cwd: repositoryRoot,
          env: apiEnvironment,
        })
      : startProcess("bun", ["run", "--cwd", "apps/backend", "start"], {
          cwd: repositoryRoot,
          env: apiEnvironment,
        });
    internalApiProcess = configuredBackendCommand
      ? startProcess("/bin/sh", ["-c", configuredBackendCommand], {
          cwd: repositoryRoot,
          env: internalApiEnvironment,
        })
      : startProcess("bun", ["run", "--cwd", "apps/backend", "start"], {
          cwd: repositoryRoot,
          env: internalApiEnvironment,
        });
    await waitForHttp(`${backendOrigin}/health`, apiProcess, "Unified native backend");
    // Internal ingress mounts only the internal API; its evidence route answers once it is up.
    await waitForHttp(
      `${internalBackendOrigin}${ReadReceiptEvidenceEndpoint.path.replace(":receiptId", "readiness")}`,
      internalApiProcess,
      "Internal native backend",
    );
    await runCommand("bun", ["run", "build"], {
      cwd: sdkRoot,
      env: dashboardEnvironment,
    });
    await runCommand("bun", ["run", "build"], {
      cwd: dashboardRoot,
      env: dashboardEnvironment,
      label: "Native Receipt owner dashboard build",
    });

    dashboardProcess = startProcess("bun", ["run", "start"], {
      cwd: dashboardRoot,
      env: dashboardEnvironment,
    });
    await waitForHttp(dashboardLoginUrl, dashboardProcess, "Dashboard");

    await runCommand(
      "nix",
      [
        "shell",
        "nixpkgs#nodejs_24",
        "--command",
        "node",
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

    const lifecycle = JSON.parse(await readFile(lifecycleEvidencePath, "utf8"));
    const postgres = await readPostgresEvidence(baseEnvironment);

    const privateFile = {
      stagingFileCount: await countFiles(stagingRoot),
      committedFileCount: await countFiles(committedRoot),
    };

    assertDurableEvidence(postgres, privateFile, lifecycle, ownerPersona.personId);
    evidence = {
      topology: {
        dashboard: "loopback-react-router",
        api: "unified-native-effect-backend",
        database:
          postgresTopology === "docker"
            ? "disposable-postgresql-docker"
            : "disposable-postgresql-local",
        privateFile: "disposable-filesystem",
      },
      postgres,
      privateFile,
      lifecycle,
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

  if (await pathExists(temporaryRoot)) {
    throw new Error("Real Receipt owner cleanup left the private temporary root behind");
  }

  await Promise.all(disposablePorts.map(assertPortAvailable));

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
