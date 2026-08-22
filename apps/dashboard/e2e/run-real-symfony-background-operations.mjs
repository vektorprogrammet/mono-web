import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  emitRuntimeEvidenceReceipts,
  sanitizePlaywrightArtifact,
} from "./runtime-evidence-receipt.mjs";

const apiOrigin = "http://127.0.0.1:8000";
const dashboardOrigin = "http://127.0.0.1:5174";
const apiPort = 8000;
const dashboardPort = 5174;
const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const runnerSourcePath = fileURLToPath(
  new URL("./run-real-symfony-background-operations.mjs", import.meta.url),
);
const specSourcePath = fileURLToPath(
  new URL("./real-symfony-background-operations.spec.ts", import.meta.url),
);
const fixtureSourcePaths = [
  fileURLToPath(
    new URL("../../server/src/App/Support/DataFixtures/ORM/InterviewRecruiterFixture.php", import.meta.url),
  ),
  fileURLToPath(
    new URL("../../server/src/App/Support/DataFixtures/ORM/AdmissionOperationsFixture.php", import.meta.url),
  ),
  fileURLToPath(
    new URL("../../server/src/App/Support/DataFixtures/ORM/BackgroundAutomationFixture.php", import.meta.url),
  ),
  fileURLToPath(
    new URL("../../server/src/App/Support/DataFixtures/ORM/BackgroundDeliveryFixture.php", import.meta.url),
  ),
];
const commandTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;
const generatedPublicPaths = [
  "public/assets",
  "public/css",
  "public/files",
  "public/images",
  "public/js",
  "public/vendor",
  "public/webfonts",
  "public/.vite",
  "public/manifest.json",
];
const journeys = [
  {
    journeyRefId: "intent://journey:parity:interview_recruiter:v1",
    stepIds: [
      "interview-recruiter-api-operation",
      "interview-recruiter-command-write",
      "interview-recruiter-legacy-route",
      "interview-recruiter-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:admission_operations:v1",
    stepIds: [
      "admission-operations-api-operation",
      "admission-operations-command-write",
      "admission-operations-legacy-route",
      "admission-operations-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:background_automation:v1",
    stepIds: [
      "background-automation-command-write",
      "background-automation-schedule-background",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:background_delivery:v1",
    stepIds: [
      "background-delivery-command-write",
      "background-delivery-external-integration",
      "background-delivery-schedule-background",
    ],
  },
];

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function assertPortAvailable(port) {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      rejectPort(new Error(`Port ${port} is already in use`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ECONNREFUSED"
      ) {
        resolvePort();
        return;
      }
      rejectPort(error);
    });
  });
}

function requireOpenSsl() {
  const result = spawnSync("openssl", ["version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(
      "Missing prerequisite: openssl must be installed and available on PATH for disposable JWT key generation.",
    );
  }
}

function runCommand(command, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const captureOutput = options.captureOutput === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: captureOutput ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    const stdoutChunks = [];
    if (captureOutput) child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, shutdownTimeoutMs);
      hardKill.unref();
      settle(rejectCommand, new Error(`${command} ${args.join(" ")} timed out`));
    }, commandTimeoutMs);
    timeout.unref();
    child.once("error", (error) => settle(rejectCommand, error));
    child.once(captureOutput ? "close" : "exit", (code, signal) => {
      if (code === 0) {
        settle(
          resolveCommand,
          captureOutput ? { stdout: Buffer.concat(stdoutChunks) } : undefined,
        );
        return;
      }
      settle(
        rejectCommand,
        new Error(
          `${command} ${args.join(" ")} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        ),
      );
    });
  });
}

function startProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    detached: true,
  });
  child.once("error", (error) => {
    console.error(`${command} failed to start:`, error);
  });
  return child;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + commandTimeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before readiness at ${url}`);
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      const body = await response.text();
      if (/\b(?:Warning|Fatal error|Parse error|Notice):/i.test(body)) {
        lastError = "PHP runtime failure in readiness response";
      } else if (response.status < 500) {
        return;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function signalProcessGroup(child, signal) {
  if (!child || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return;
    }
    throw error;
  }
}

async function stopProcess(child) {
  if (!child || child.pid === undefined) return;
  if (child.exitCode !== null) {
    signalProcessGroup(child, "SIGTERM");
    return;
  }
  let resolveExit;
  const exited = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  child.once("exit", resolveExit);
  signalProcessGroup(child, "SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    sleep(shutdownTimeoutMs).then(() => false),
  ]);
  if (graceful || child.exitCode !== null) return;
  signalProcessGroup(child, "SIGKILL");
  await Promise.race([
    exited,
    sleep(shutdownTimeoutMs).then(() => undefined),
  ]);
}

function assertDisposableDatabase(databasePath, temporaryRoot) {
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  if (
    databasePath === ":memory:" ||
    databasePath.includes(":memory:") ||
    resolvedDatabasePath.includes("dev.db") ||
    resolvedDatabasePath.includes("prod.db") ||
    !resolvedDatabasePath.startsWith(`${resolvedTemporaryRoot}/`)
  ) {
    throw new Error(`Refusing non-disposable e2e database path: ${databasePath}`);
  }
}

function assertDisposableDatabaseUrl(databaseUrl, temporaryRoot) {
  const prefix = "sqlite:///";
  if (!databaseUrl.startsWith(prefix)) {
    throw new Error(`Refusing non-SQLite e2e database URL: ${databaseUrl}`);
  }
  assertDisposableDatabase(databaseUrl.slice(prefix.length), temporaryRoot);
}

function assertReceiptConfiguration() {
  const receiptEnvironment = [
    "RUNTIME_EVIDENCE_RECEIPT_PATH",
    "RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_MONO_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS",
  ];
  const configured = receiptEnvironment.filter((name) => {
    const value = process.env[name];
    return value !== undefined && value.length > 0;
  });
  if (configured.length > 0 && configured.length !== receiptEnvironment.length) {
    throw new Error(
      `Runtime evidence receipt configuration is partial; set all of ${receiptEnvironment.join(", ")}`,
    );
  }
  return configured.length === receiptEnvironment.length;
}

async function queryScalar(databasePath, sql) {
  const result = await runCommand(
    "php",
    [
      "-r",
      '$pdo = new PDO("sqlite:".$argv[1]); $value = $pdo->query($argv[2])->fetchColumn(); if ($value === false) { exit(2); } echo $value;',
      databasePath,
      sql,
    ],
    { cwd: serverRoot, env: process.env, captureOutput: true },
  );
  return result.stdout.toString("utf8").trim();
}

async function main() {
  requireOpenSsl();
  const receiptRequested = assertReceiptConfiguration();
  await assertPortAvailable(apiPort);
  await assertPortAvailable(dashboardPort);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-background-operations-0032-"));
  const databasePath = join(temporaryRoot, "background-operations.sqlite");
  const privateKeyPath = join(temporaryRoot, "jwt-private.pem");
  const publicKeyPath = join(temporaryRoot, "jwt-public.pem");
  const routerPath = join(temporaryRoot, "router.php");
  const receiptUploadDir = join(temporaryRoot, "uploads", "receipts");
  const profileUploadDir = join(temporaryRoot, "uploads", "profile-photos");
  const symfonyCacheDir = join(serverRoot, "var/cache/e2e");
  const symfonyLogDir = join(serverRoot, "var/log/e2e");
  const symfonySessionDir = join(serverRoot, "var/sessions/e2e");
  const playwrightResultsDir = join(dashboardRoot, "e2e/results");
  const playwrightReportDir = join(dashboardRoot, "playwright-report");
  assertDisposableDatabase(databasePath, temporaryRoot);
  const databaseUrl = `sqlite:///${databasePath}`;

  const serverEnv = {
    ...process.env,
    APP_ENV: "e2e",
    APP_DEBUG: "0",
    APP_SECRET: randomBytes(32).toString("hex"),
    DATABASE_URL: databaseUrl,
    E2E_DATABASE_URL: databaseUrl,
    E2E_JWT_SECRET_KEY: privateKeyPath,
    E2E_JWT_PUBLIC_KEY: publicKeyPath,
    E2E_JWT_PASSPHRASE: "",
    JWT_PASSPHRASE: "",
    CORS_ALLOW_ORIGIN: dashboardOrigin,
    E2E_RECEIPT_IMAGES: receiptUploadDir,
    E2E_PROFILE_PHOTOS: profileUploadDir,
    SLACK_DISABLED: "true",
    SMS_DISABLE: "true",
    GOOGLE_API_CLIENT_ID: "e2e-disabled",
    GOOGLE_API_CLIENT_SECRET: "e2e-disabled",
    GOOGLE_API_REFRESH_TOKEN: "e2e-disabled",
    GATEWAY_API_TOKEN: "e2e-disabled",
    DEFAULT_SURVEY_EMAIL: "e2e@example.invalid",
    DEFAULT_FROM_EMAIL: "e2e@example.invalid",
    ECONOMY_EMAIL: "e2e@example.invalid",
    MAILER_DSN: "null://null",
    IPINFO_TOKEN: "",
    GEO_IGNORED_ASNS: "[]",
    LOG_CHANNEL: "e2e",
    SLACK_ENDPOINT: "http://127.0.0.1:9/disabled",
    RECAPTCHA_PUBLIC_KEY: "",
    RECAPTCHA_PRIVATE_KEY: "",
  };
  assertDisposableDatabaseUrl(serverEnv.DATABASE_URL, temporaryRoot);
  assertDisposableDatabaseUrl(serverEnv.E2E_DATABASE_URL, temporaryRoot);

  const dashboardEnv = {
    ...process.env,
    REAL_SYMFONY_RECRUITMENT_E2E: "1",
    REAL_SYMFONY_BACKGROUND_OPERATIONS_E2E: "1",
    API_URL: apiOrigin,
    VITE_API_URL: apiOrigin,
    API_MODE: "",
    VITE_API_MODE: "",
    DASHBOARD_ORIGIN: dashboardOrigin,
    HOST: "127.0.0.1",
    PORT: String(dashboardPort),
  };

  let symfonyProcess;
  let dashboardProcess;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const cleanupErrors = [];
    for (const process of [dashboardProcess, symfonyProcess]) {
      try {
        await stopProcess(process);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const directory of [
      temporaryRoot,
      symfonyCacheDir,
      symfonyLogDir,
      symfonySessionDir,
      playwrightResultsDir,
      playwrightReportDir,
      receiptUploadDir,
      profileUploadDir,
    ]) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const relativePath of generatedPublicPaths) {
      try {
        await rm(join(serverRoot, relativePath), { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Real Symfony background e2e cleanup failed");
    }
  };
  const handleSignal = (signal) => {
    void cleanup()
      .catch((cleanupError) => {
        console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError);
      })
      .finally(() => {
        process.exitCode = signal === "SIGINT" ? 130 : 143;
      });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  let primaryError;
  try {
    await rm(symfonyCacheDir, { recursive: true, force: true });
    await rm(symfonyLogDir, { recursive: true, force: true });
    await rm(symfonySessionDir, { recursive: true, force: true });
    await runCommand("openssl", ["genrsa", "-out", privateKeyPath, "2048"], {
      cwd: serverRoot,
      env: serverEnv,
    });
    await runCommand(
      "openssl",
      ["rsa", "-pubout", "-in", privateKeyPath, "-out", publicKeyPath],
      { cwd: serverRoot, env: serverEnv },
    );
    await chmod(privateKeyPath, 0o600);

    await runCommand(
      "php",
      ["bin/console", "doctrine:schema:create", "--env=e2e", "--no-interaction"],
      { cwd: serverRoot, env: serverEnv },
    );
    await runCommand(
      "php",
      [
        "bin/console",
        "doctrine:fixtures:load",
        "--env=e2e",
        "--group=background-operations",
        "--no-interaction",
      ],
      { cwd: serverRoot, env: serverEnv },
    );
    const fixtureInputBytes = Buffer.concat(
      await Promise.all(fixtureSourcePaths.map((path) => readFile(path))),
    );

    await writeFile(
      routerPath,
      `<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (is_string($path) && is_file($_SERVER['DOCUMENT_ROOT'].$path)) {
    return false;
}
require $_SERVER['DOCUMENT_ROOT'].'/index.php';
`,
      "utf8",
    );
    await runCommand("bun", ["run", "build:prod"], {
      cwd: serverRoot,
      env: serverEnv,
    });
    symfonyProcess = startProcess(
      "php",
      [
        "-d",
        "variables_order=EGPCS",
        "-S",
        "127.0.0.1:8000",
        "-t",
        "public",
        routerPath,
      ],
      { cwd: serverRoot, env: serverEnv },
    );
    await waitForHttp(`${apiOrigin}/api/docs`, symfonyProcess);

    await runCommand("bun", ["run", "build"], {
      cwd: dashboardRoot,
      env: dashboardEnv,
    });
    dashboardProcess = startProcess("bun", ["run", "start"], {
      cwd: dashboardRoot,
      env: dashboardEnv,
    });
    await waitForHttp(`${dashboardOrigin}/login`, dashboardProcess);

    await runCommand(
      "php",
      ["bin/console", "app:update:roles", "--env=e2e", "--no-interaction"],
      { cwd: serverRoot, env: serverEnv },
    );
    await runCommand(
      "php",
      ["bin/console", "app:admission:send_notifications", "--env=e2e", "--no-interaction"],
      { cwd: serverRoot, env: serverEnv },
    );
    await runCommand(
      "php",
      [
        "bin/console",
        "app:admission:send_info_meeting_notifications",
        "--env=e2e",
        "--no-interaction",
      ],
      { cwd: serverRoot, env: serverEnv },
    );
    await runCommand(
      "php",
      ["bin/console", "app:send_accept_interview_reminder", "--env=e2e", "--no-interaction"],
      { cwd: serverRoot, env: serverEnv },
    );
    await runCommand(
      "php",
      ["bin/console", "app:send_interview_lists", "--env=e2e", "--no-interaction"],
      { cwd: serverRoot, env: serverEnv },
    );

    const notificationCount = await queryScalar(
      databasePath,
      "SELECT COUNT(n.id) FROM admission_notification n JOIN admission_subscriber s ON s.id = n.subscriber_id WHERE s.email = 'background-delivery-subscriber-0032@example.invalid'",
    );
    if (notificationCount !== "2") {
      throw new Error(`Expected two local admission delivery notifications, got ${notificationCount}`);
    }
    const reminderCount = await queryScalar(
      databasePath,
      "SELECT num_accept_interview_reminders_sent FROM interview i JOIN \"user\" u ON u.id = i.user_id WHERE u.email = 'background-delivery-reminder-0032@example.invalid'",
    );
    if (reminderCount !== "1") {
      throw new Error(`Expected one local interview reminder delivery, got ${reminderCount}`);
    }
    const recruiterReminderCount = await queryScalar(
      databasePath,
      "SELECT num_accept_interview_reminders_sent FROM interview i JOIN \"user\" u ON u.id = i.user_id WHERE u.email = 'background-delivery-applicant-0032@example.invalid'",
    );
    if (recruiterReminderCount !== "1") {
      throw new Error(`Expected one recruiter reminder delivery, got ${recruiterReminderCount}`);
    }

    const e2eArgs = [
      resolve(dashboardRoot, "node_modules/@playwright/test/cli.js"),
      "test",
      "e2e/real-symfony-background-operations.spec.ts",
      "--project=real-symfony",
    ];
    if (receiptRequested) e2eArgs.push("--reporter=json");
    const e2eResult = await runCommand(
      process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
      e2eArgs,
      { cwd: dashboardRoot, env: dashboardEnv, captureOutput: receiptRequested },
    );

    const applicationSubscriberCount = await queryScalar(
      databasePath,
      "SELECT COUNT(id) FROM admission_subscriber WHERE email = 'background-admission-applicant-0032@example.invalid'",
    );
    if (applicationSubscriberCount !== "1") {
      throw new Error(
        `Expected the Symfony application event seam to create one subscriber, got ${applicationSubscriberCount}`,
      );
    }

    if (receiptRequested) {
      const runnerSourceRefIds = (process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (runnerSourceRefIds.length !== 2) {
        throw new Error(
          "Runtime evidence requires exactly two runner source references for the background runner and browser suite.",
        );
      }
      await emitRuntimeEvidenceReceipts({
        journeys,
        fixtureId: "background-operations-0032",
        runnerSourceInputBytes: [
          { sourceRefId: runnerSourceRefIds[0], bytes: await readFile(runnerSourcePath) },
          { sourceRefId: runnerSourceRefIds[1], bytes: await readFile(specSourcePath) },
        ],
        fixtureInputBytes,
        artifactBytes: sanitizePlaywrightArtifact(e2eResult.stdout),
      });
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (primaryError) {
        console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError);
      } else {
        throw cleanupError;
      }
    } finally {
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);
    }
  }
}

if (process.versions.bun === undefined) {
  const result = spawnSync("bun", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} else {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
