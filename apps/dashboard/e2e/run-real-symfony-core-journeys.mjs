import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  emitRuntimeEvidenceReceipts,
  sanitizePlaywrightArtifact,
} from "./runtime-evidence-receipt.mjs";

const apiOrigin = "http://127.0.0.1:8000";
const apiPort = 8000;
const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const runnerSourcePath = fileURLToPath(new URL("./run-real-symfony-core-journeys.mjs", import.meta.url));
const specSourcePath = fileURLToPath(new URL("./real-symfony-core-journeys.spec.ts", import.meta.url));
const fixtureSourcePath = fileURLToPath(new URL("../../server/tests/Fixtures/CoreUserJourneyFixture.php", import.meta.url));
const receiptImageSourcePath = fileURLToPath(new URL("../../server/images/receipts/698c00086228f.png", import.meta.url));
const commandTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;

const journeys = [
  {
    journeyRefId: "intent://journey:parity:applicant_admission:v1",
    stepIds: [
      "applicant-admission-api-operation",
      "applicant-admission-command-write",
      "applicant-admission-legacy-route",
      "applicant-admission-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:contact_public:v1",
    stepIds: [
      "contact-public-api-operation",
      "contact-public-command-write",
      "contact-public-legacy-route",
      "contact-public-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:content_public:v1",
    stepIds: [
      "content-public-api-operation",
      "content-public-command-write",
      "content-public-legacy-route",
      "content-public-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:files_media:v1",
    stepIds: [
      "files-media-command-write",
      "files-media-legacy-route",
      "files-media-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:identity_self:v1",
    stepIds: [
      "identity-self-api-operation",
      "identity-self-command-write",
      "identity-self-legacy-route",
      "identity-self-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:receipt_self:v1",
    stepIds: [
      "receipt-self-api-operation",
      "receipt-self-command-write",
      "receipt-self-legacy-route",
      "receipt-self-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:survey_participate:v1",
    stepIds: [
      "survey-participate-api-operation",
      "survey-participate-command-write",
      "survey-participate-legacy-route",
      "survey-participate-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:team_interest_self:v1",
    stepIds: [
      "team-interest-self-api-operation",
      "team-interest-self-command-write",
      "team-interest-self-legacy-route",
      "team-interest-self-mono-route",
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
      if (error && typeof error === "object" && "code" in error && error.code === "ECONNREFUSED") {
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
      const phpFailure = /\b(?:Warning|Fatal error|Parse error|Notice):/i.test(body);
      if (phpFailure) {
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

async function main() {
  requireOpenSsl();
  await assertPortAvailable(apiPort);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-core-journeys-0032-"));
  const databasePath = join(temporaryRoot, "core-journeys.sqlite");
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
  assertDisposableDatabase(databasePath, temporaryRoot);
  const databaseUrl = `sqlite:///${databasePath}`;
  let symfonyProcess;
  let cleaned = false;

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
    CORS_ALLOW_ORIGIN: apiOrigin,
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
    REAL_SYMFONY_CORE_E2E: "1",
    API_URL: apiOrigin,
    VITE_API_URL: apiOrigin,
    API_MODE: "",
    VITE_API_MODE: "",
  };

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const cleanupErrors = [];

    try {
      await stopProcess(symfonyProcess);
    } catch (error) {
      cleanupErrors.push(error);
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
      throw new AggregateError(cleanupErrors, "Real Symfony core e2e cleanup failed");
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
        "--group=core-user-journeys",
        "--no-interaction",
      ],
      { cwd: serverRoot, env: serverEnv },
    );
    const fixtureInputBytes = Buffer.concat([
      await readFile(fixtureSourcePath),
      await readFile(receiptImageSourcePath),
    ]);
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
        `${apiOrigin.replace("http://", "")}`,
        "-t",
        "public",
        routerPath,
      ],
      { cwd: serverRoot, env: serverEnv },
    );
    await waitForHttp(`${apiOrigin}/api/docs`, symfonyProcess);

    const receiptRequested = [
      "RUNTIME_EVIDENCE_RECEIPT_PATH",
      "RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID",
      "RUNTIME_EVIDENCE_MONO_REVISION_REF_ID",
      "RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS",
    ].some((name) => typeof process.env[name] === "string" && process.env[name].length > 0);
    const e2eArgs = [
      resolve(dashboardRoot, "node_modules/@playwright/test/cli.js"),
      "test",
      "e2e/real-symfony-core-journeys.spec.ts",
      "--project=real-symfony",
    ];
    if (receiptRequested) e2eArgs.push("--reporter=json");
    const e2eResult = await runCommand(
      process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
      e2eArgs,
      { cwd: dashboardRoot, env: dashboardEnv, captureOutput: receiptRequested },
    );

    if (receiptRequested) {
      const runnerSourceRefIds = (process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (runnerSourceRefIds.length !== 2) {
        throw new Error(
          "Runtime evidence requires exactly two runner source references for the core journey runner and spec.",
        );
      }
      const runnerSourceInputBytes = [
        {
          sourceRefId: runnerSourceRefIds[0],
          bytes: await readFile(runnerSourcePath),
        },
        {
          sourceRefId: runnerSourceRefIds[1],
          bytes: await readFile(specSourcePath),
        },
      ];
      await emitRuntimeEvidenceReceipts({
        journeys,
        fixtureId: "core-user-journeys-0032",
        runnerSourceInputBytes,
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
