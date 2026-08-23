import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const composeFile = join(repositoryRoot, "docker-compose.yml");
const dashboardOrigin = "http://127.0.0.1:5174";
const backendOrigin = "http://127.0.0.1:8791";
const postgresUrl = "postgres://receipt:receipt@127.0.0.1:55432/receipt_proof?connect_timeout=1";
const composeProject = `mono-web-admission-0038-${process.pid}`;
const commandTimeoutMs = 300_000;
const shutdownTimeoutMs = 5_000;
const postgresPort = 55432;
const nixPostgresPackage = "nixpkgs#postgresql_17";
const fixedClock = "2031-09-15T12:00:00.000Z";
const departmentId = "department-trondheim";
const foreignDepartmentId = "department-bergen";
const semesterId = "semester-autumn-2031";
const fieldOfStudyId = "field-mathematics";
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
  return runCommand("nix", ["shell", nixPostgresPackage, "--command", command, ...args], options);
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) return;

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
    if (child.exitCode !== null) throw new Error(`${label} exited before readiness`);
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
        label: "Disposable admission PostgreSQL readiness check",
        captureOutput: true,
      };
      if (postgresTopology === "docker") await runCommand("docker", args, options);
      else await runNixPostgres("pg_isready", args, options);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Disposable admission PostgreSQL did not become ready");
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
      label: "Local admission PostgreSQL initialization",
    },
  );
  await runNixPostgres(
    "pg_ctl",
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
      label: "Local admission PostgreSQL startup",
    },
  );
  await waitForPostgres(environment);
  await runNixPostgres(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local admission PostgreSQL database creation",
    },
  );
}

async function stopLocalPostgres(dataRoot, environment) {
  await runNixPostgres("pg_ctl", ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    label: "Local admission PostgreSQL cleanup",
  });
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

async function runPsql(sql, environment, label) {
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
    label,
    captureOutput: true,
  };
  return postgresTopology === "docker"
    ? runCommand("docker", args, options)
    : runNixPostgres("psql", args, options);
}

async function seedReferenceData(environment) {
  await runPsql(
    `
      INSERT INTO admission_period_departments (department_id, name)
      VALUES
        ('${departmentId}', 'Trondheim'),
        ('${foreignDepartmentId}', 'Bergen');
      INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
      VALUES ('${semesterId}', '2031-08-01T00:00:00.000Z', '2031-12-31T00:00:00.000Z');
      INSERT INTO admission_period_fields_of_study (
        field_of_study_id,
        department_id,
        name,
        active
      ) VALUES ('${fieldOfStudyId}', '${departmentId}', 'Matematikk', TRUE);
    `,
    environment,
    "Admission reference-data seed",
  );
}

async function readPostgresEvidence(environment) {
  const result = await runPsql(
    `
      SELECT json_build_object(
        'periodCount', (SELECT count(*) FROM admission_periods),
        'commandCount', (SELECT count(*) FROM admission_period_command_receipts),
        'auditCount', (SELECT count(*) FROM admission_period_audit),
        'outboxCount', (SELECT count(*) FROM admission_period_outbox),
        'duplicateEffectCount', (
          SELECT count(*) FROM (
            SELECT effect_id FROM admission_period_outbox
            GROUP BY effect_id HAVING count(*) > 1
          ) duplicate_effects
        ),
        'applicationCount', (SELECT count(*) FROM admission_applications),
        'applicationCommandCount', (
          SELECT count(*) FROM admission_application_command_receipts
        ),
        'period', (
          SELECT json_build_object(
            'id', admission_period_id,
            'departmentId', department_id,
            'semesterId', semester_id,
            'startAt', start_at,
            'endAt', end_at,
            'revision', revision,
            'lastCommandId', last_command_id
          ) FROM admission_periods LIMIT 1
        ),
        'application', (
          SELECT json_build_object(
            'id', application_id,
            'applicantId', applicant_id,
            'admissionPeriodId', admission_period_id
          ) FROM admission_applications LIMIT 1
        ),
        'audits', COALESCE((
          SELECT json_agg(json_build_object(
            'commandId', command_id,
            'admissionPeriodId', admission_period_id,
            'action', action,
            'revision', admission_period_revision
          ) ORDER BY admission_period_revision)
          FROM admission_period_audit
        ), '[]'::json),
        'outbox', COALESCE((
          SELECT json_agg(json_build_object(
            'effectId', effect_id,
            'effectType', effect_type,
            'admissionPeriodId', admission_period_id,
            'commandId', command_id,
            'ordinal', ordinal
          ) ORDER BY command_id, ordinal)
          FROM admission_period_outbox
        ), '[]'::json)
      )::text;
    `,
    environment,
    "Admission persistence evidence query",
  );
  return JSON.parse(result.stdout.trim());
}

function assertDurableEvidence(postgres, lifecycle) {
  const audits = Array.isArray(postgres.audits) ? postgres.audits : [];
  const outbox = Array.isArray(postgres.outbox) ? postgres.outbox : [];
  const acceptedCommandIds = [
    lifecycle.period.createCommandId,
    lifecycle.period.concurrentWinnerCommandId,
    lifecycle.period.closeCommandId,
  ];
  const auditCommandIds = audits.map((audit) => audit.commandId);
  const outboxCommandIds = outbox.map((effect) => effect.commandId);
  const expectedActions = [
    "AdmissionPeriodCreated",
    "AdmissionPeriodRevised",
    "AdmissionPeriodRevised",
  ];

  if (
    postgres.periodCount !== 1 ||
    postgres.commandCount !== 3 ||
    postgres.auditCount !== 3 ||
    postgres.outboxCount !== 3 ||
    postgres.duplicateEffectCount !== 0 ||
    postgres.applicationCount !== 1 ||
    postgres.applicationCommandCount !== 1 ||
    postgres.period?.id !== lifecycle.period.id ||
    postgres.period?.revision !== lifecycle.period.finalRevision ||
    postgres.period?.lastCommandId !== lifecycle.period.closeCommandId ||
    postgres.application?.id !== lifecycle.application.id ||
    postgres.application?.admissionPeriodId !== lifecycle.period.id ||
    lifecycle.publicEligibility.beforeClose.includes(lifecycle.period.id) !== true ||
    lifecycle.publicEligibility.afterClose.includes(lifecycle.period.id) ||
    lifecycle.replay.tag !== "Replayed" ||
    lifecycle.concurrent.loser.tag !== "StaleAdmissionPeriodRevision" ||
    audits.map((audit) => audit.revision).join(",") !== "0,1,2" ||
    audits.map((audit) => audit.action).join(",") !== expectedActions.join(",") ||
    acceptedCommandIds.some((commandId) => !auditCommandIds.includes(commandId)) ||
    acceptedCommandIds.some((commandId) => !outboxCommandIds.includes(commandId)) ||
    outbox.some(
      (effect) => effect.effectType !== "PublishAdmissionPeriodChanged" || effect.ordinal !== 0,
    )
  ) {
    throw new Error("Admission persistence evidence did not prove the frozen journey laws");
  }
}

async function main() {
  await Promise.all([
    assertPortAvailable(5174),
    assertPortAvailable(8791),
    assertPortAvailable(55432),
  ]);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-admission-0038-"));
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const stagingRoot = join(temporaryRoot, "receipt-staging");
  const committedRoot = join(temporaryRoot, "receipt-committed");
  const lifecycleEvidencePath = join(temporaryRoot, "admission-lifecycle-evidence.json");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);

  const leaderToken = randomBytes(32).toString("base64url");
  const foreignLeaderToken = randomBytes(32).toString("base64url");
  const globalAdminToken = randomBytes(32).toString("base64url");
  const inactiveToken = randomBytes(32).toString("base64url");
  const roleDeniedToken = randomBytes(32).toString("base64url");
  const admissionTokens = JSON.stringify({
    [leaderToken]: {
      _tag: "DepartmentLeader",
      personId: "leader-trondheim",
      departmentId,
      active: true,
    },
    [foreignLeaderToken]: {
      _tag: "DepartmentLeader",
      personId: "leader-bergen",
      departmentId: foreignDepartmentId,
      active: true,
    },
    [globalAdminToken]: {
      _tag: "GlobalAdmin",
      personId: "global-administrator",
      active: true,
    },
    [inactiveToken]: {
      _tag: "DepartmentLeader",
      personId: "inactive-leader",
      departmentId,
      active: false,
    },
    [roleDeniedToken]: {
      _tag: "Member",
      personId: "member-trondheim",
      departmentId,
      active: true,
    },
  });
  const receiptPrincipal = (personId, actorDepartmentId, active) => ({
    personId,
    departmentId: actorDepartmentId,
    active,
    paymentAccountCiphertext: randomBytes(32).toString("base64url"),
    approvalScope: { _tag: "None" },
  });
  const receiptTokens = JSON.stringify({
    [leaderToken]: receiptPrincipal("leader-trondheim", departmentId, true),
    [foreignLeaderToken]: receiptPrincipal("leader-bergen", foreignDepartmentId, true),
    [globalAdminToken]: receiptPrincipal("global-administrator", departmentId, true),
    [inactiveToken]: receiptPrincipal("inactive-leader", departmentId, false),
    [roleDeniedToken]: receiptPrincipal("member-trondheim", departmentId, true),
  });
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;

  const apiEnvironment = {
    ...baseEnvironment,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: "8791",
    BACKEND_PG_URL: postgresUrl,
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    ADMISSION_AUTH_TOKENS: admissionTokens,
    ADMISSION_FIXED_NOW: fixedClock,
    RECEIPT_AUTH_TOKENS: receiptTokens,
    RECEIPT_STAGING_ROOT: stagingRoot,
    RECEIPT_COMMITTED_ROOT: committedRoot,
    RECEIPT_MAX_FILE_BYTES: "10485760",
    RECEIPT_E2E_TEST_MODE: "1",
  };
  const dashboardEnvironment = {
    ...baseEnvironment,
    API_URL: backendOrigin,
    VITE_API_URL: backendOrigin,
  };
  const playwrightEnvironment = {
    ...dashboardEnvironment,
    REAL_ADMISSION_PERIOD_E2E: "1",
    BACKEND_ORIGIN: backendOrigin,
    DASHBOARD_ORIGIN: dashboardOrigin,
    ADMISSION_E2E_LEADER_TOKEN: leaderToken,
    ADMISSION_E2E_FOREIGN_LEADER_TOKEN: foreignLeaderToken,
    ADMISSION_E2E_GLOBAL_ADMIN_TOKEN: globalAdminToken,
    ADMISSION_E2E_INACTIVE_TOKEN: inactiveToken,
    ADMISSION_E2E_ROLE_DENIED_TOKEN: roleDeniedToken,
    ADMISSION_E2E_LIFECYCLE_EVIDENCE_PATH: lifecycleEvidencePath,
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
              label: "Disposable admission PostgreSQL cleanup",
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
      throw new AggregateError(cleanupErrors, "Admission topology cleanup failed");
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
        ["compose", "-f", composeFile, "-p", composeProject, "up", "-d", "receipt-postgres"],
        {
          cwd: repositoryRoot,
          env: baseEnvironment,
          label: "Disposable admission PostgreSQL startup",
        },
      );
      await waitForPostgres(baseEnvironment);
    } else {
      await startLocalPostgres(postgresDataRoot, baseEnvironment);
    }

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
    await waitForHttp(`${backendOrigin}/health`, apiProcess, "Unified native backend");
    await seedReferenceData(baseEnvironment);

    await runCommand("bun", ["run", "build"], {
      cwd: sdkRoot,
      env: dashboardEnvironment,
      label: "Admission SDK build",
    });
    dashboardProcess = startProcess(
      "nix",
      [
        "shell",
        "nixpkgs#nodejs_24",
        "--command",
        "node",
        "node_modules/@react-router/dev/dist/cli/index.js",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        "5174",
      ],
      { cwd: dashboardRoot, env: dashboardEnvironment },
    );
    await waitForHttp(`${dashboardOrigin}/login`, dashboardProcess, "Dashboard");

    await runCommand(
      "nix",
      [
        "shell",
        "nixpkgs#nodejs_24",
        "--command",
        "node",
        "./node_modules/@playwright/test/cli.js",
        "test",
        "e2e/admission-period-management.spec.ts",
        "--project=admission-period-management",
        "--workers=1",
        "--retries=0",
      ],
      {
        cwd: dashboardRoot,
        env: playwrightEnvironment,
        label: "Real admission-period Playwright journey",
      },
    );

    const lifecycle = JSON.parse(await readFile(lifecycleEvidencePath, "utf8"));
    const postgres = await readPostgresEvidence(baseEnvironment);
    assertDurableEvidence(postgres, lifecycle);
    evidence = {
      topology: {
        dashboard: "loopback-react-router",
        api: "unified-native-effect-backend",
        database:
          postgresTopology === "docker"
            ? "disposable-postgresql-docker"
            : "disposable-postgresql-local-nix",
        browser: "real-chromium",
        fixedClock,
      },
      postgres,
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
    throw new AggregateError([primaryError, cleanupError], "Admission journey and cleanup failed");
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;

  if (await pathExists(temporaryRoot)) {
    throw new Error("Admission cleanup left the temporary root behind");
  }
  await Promise.all([
    assertPortAvailable(5174),
    assertPortAvailable(8791),
    assertPortAvailable(55432),
  ]);

  process.stdout.write(
    `${JSON.stringify({
      ...evidence,
      cleanup: {
        postgresRemoved: true,
        temporaryRootRemoved: true,
        portsReleased: [5174, 8791, 55432],
      },
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Real admission runner failed"}\n`,
  );
  process.exitCode = 1;
});
