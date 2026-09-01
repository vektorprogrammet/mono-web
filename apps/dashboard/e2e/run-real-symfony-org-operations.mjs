import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  emitRuntimeEvidenceReceipts,
  sanitizePlaywrightArtifact,
} from "./runtime-evidence-receipt.mjs";

const legacyOrigin = "http://127.0.0.1:8000";
const nativeOrigin = "http://127.0.0.1:8872";
const dashboardOrigin = "http://127.0.0.1:5174";
const legacyPort = 8000;
const nativePort = 8872;
const dashboardPort = 5174;
const postgresPort = 55472;
const postgresDatabase = "schools_e2e_0061";
const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/${postgresDatabase}`;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const backendRoot = fileURLToPath(new URL("../../backend/", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const runnerSourcePath = fileURLToPath(import.meta.url);
const specSourcePath = fileURLToPath(
  new URL("./real-symfony-org-operations.spec.ts", import.meta.url),
);
const legacyFixtureSourcePath = fileURLToPath(
  new URL("../../server/tests/Fixtures/OrgOperationsJourneyFixture.php", import.meta.url),
);
const nativeFixtureSourcePath = fileURLToPath(
  new URL("./native-schools-directory-seed.mjs", import.meta.url),
);
const nativeSeedPath = nativeFixtureSourcePath;
const betterAuthSecret = randomBytes(32).toString("hex");
const commandTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;

const journeys = [
  {
    journeyRefId: "intent://journey:parity:identity_admin:v1",
    stepIds: [
      "identity-admin-api-operation",
      "identity-admin-command-write",
      "identity-admin-legacy-route",
      "identity-admin-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:school_scheduling:v1",
    stepIds: [
      "school-scheduling-api-operation",
      "school-scheduling-command-write",
      "school-scheduling-legacy-route",
      "school-scheduling-mono-route",
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
      if (error?.code === "ECONNREFUSED") {
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
    throw new Error("Missing prerequisite: openssl must be installed and available on PATH.");
  }
}

function requirePostgres17() {
  const result = spawnSync("postgres", ["--version"], { encoding: "utf8" });
  if (
    result.error ||
    result.status !== 0 ||
    !/PostgreSQL\) 17\./u.test(`${result.stdout ?? ""}${result.stderr ?? ""}`)
  ) {
    throw new Error("Missing prerequisite: PostgreSQL 17 must be installed and available on PATH.");
  }
}

async function hybridFixtureManifestBytes() {
  const sources = [
    {
      path: "apps/server/tests/Fixtures/OrgOperationsJourneyFixture.php",
      bytes: await readFile(legacyFixtureSourcePath),
    },
    {
      path: "apps/dashboard/e2e/native-schools-directory-seed.mjs",
      bytes: await readFile(nativeFixtureSourcePath),
    },
  ];
  return Buffer.from(
    JSON.stringify(
      sources.map((source) => ({
        source_path: source.path,
        bytes_base64: Buffer.from(source.bytes).toString("base64"),
      })),
    ),
    "utf8",
  );
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
        settle(resolveCommand, captureOutput ? { stdout: Buffer.concat(stdoutChunks) } : undefined);
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
  child.once("error", (error) => console.error(`${command} failed to start:`, error));
  return child;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + commandTimeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Process exited before readiness at ${url}`);
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

async function waitForPort(port, child, label) {
  const deadline = Date.now() + commandTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before readiness`);
    const ready = await new Promise((resolvePort) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolvePort(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolvePort(false);
      });
    });
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label} on port ${port}`);
}

function signalProcessGroup(child, signal) {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
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
  await Promise.race([exited, sleep(shutdownTimeoutMs).then(() => undefined)]);
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
  requirePostgres17();
  await Promise.all([legacyPort, nativePort, dashboardPort, postgresPort].map(assertPortAvailable));

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-hybrid-org-operations-0032-"));
  const databasePath = join(temporaryRoot, "org-operations.sqlite");
  const postgresDataDir = join(temporaryRoot, "postgres");
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
  let postgresProcess;
  let nativeBackendProcess;
  let symfonyProcess;
  let dashboardProcess;
  let cleaned = false;

  const serverEnv = {
    ...process.env,
    APP_ENV: "e2e",
    APP_DEBUG: "0",
    TZ: "Europe/Oslo",
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

  const nativeBackendEnv = {
    ...process.env,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(nativePort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: betterAuthSecret,
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    ADMISSION_AUTH_TOKENS: "{}",
    RECEIPT_AUTH_TOKENS: "{}",
    ORGANIZATION_AUTH_TOKENS: "{}",
  };
  delete nativeBackendEnv.API_MODE;
  delete nativeBackendEnv.VITE_API_MODE;

  const dashboardEnv = { ...process.env };
  delete dashboardEnv.API_MODE;
  delete dashboardEnv.VITE_API_MODE;
  delete dashboardEnv.ALCHEMY_CLOUDFLARE_VITE_INJECTED;
  dashboardEnv.REAL_SYMFONY_ORG_OPERATIONS_E2E = "1";
  // The existing Playwright config uses this real-dashboard project switch.
  dashboardEnv.REAL_SYMFONY_INTERVIEW_SCHEDULING_E2E = "1";
  dashboardEnv.API_URL = nativeOrigin;
  dashboardEnv.VITE_API_URL = nativeOrigin;
  dashboardEnv.LEGACY_SYMFONY_URL = legacyOrigin;
  dashboardEnv.DASHBOARD_ORIGIN = dashboardOrigin;
  dashboardEnv.VITE_DASHBOARD_ORIGIN = dashboardOrigin;
  dashboardEnv.HOST = "127.0.0.1";
  dashboardEnv.PORT = String(dashboardPort);

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const cleanupErrors = [];
    for (const child of [dashboardProcess, nativeBackendProcess, symfonyProcess, postgresProcess]) {
      try {
        await stopProcess(child);
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
      throw new AggregateError(cleanupErrors, "Hybrid organization operations cleanup failed");
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
  let primaryFailed = false;
  try {
    for (const directory of [symfonyCacheDir, symfonyLogDir, symfonySessionDir]) {
      await rm(directory, { recursive: true, force: true });
    }

    await runCommand(
      "initdb",
      [
        "-D",
        postgresDataDir,
        "--username=postgres",
        "--auth-local=trust",
        "--auth-host=trust",
        "--no-locale",
        "--encoding=UTF8",
      ],
      { cwd: repositoryRoot, env: process.env },
    );
    postgresProcess = startProcess(
      "postgres",
      ["-D", postgresDataDir, "-p", String(postgresPort), "-h", "127.0.0.1", "-k", temporaryRoot],
      { cwd: repositoryRoot, env: process.env },
    );
    await waitForPort(postgresPort, postgresProcess, "PostgreSQL 17");
    await runCommand(
      "createdb",
      ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres", postgresDatabase],
      { cwd: repositoryRoot, env: process.env },
    );
    await runCommand("bun", [nativeSeedPath], {
      cwd: databaseRoot,
      env: {
        ...process.env,
        SCHOOLS_E2E_PG_URL: postgresUrl,
        SCHOOLS_E2E_DASHBOARD_ORIGIN: dashboardOrigin,
        BETTER_AUTH_SECRET: betterAuthSecret,
      },
    });
    nativeBackendProcess = startProcess("bun", ["run", "src/main.ts"], {
      cwd: backendRoot,
      env: nativeBackendEnv,
    });
    await waitForHttp(`${nativeOrigin}/health`, nativeBackendProcess);

    await runCommand("openssl", ["genrsa", "-out", privateKeyPath, "2048"], {
      cwd: serverRoot,
      env: serverEnv,
    });
    await runCommand("openssl", ["rsa", "-pubout", "-in", privateKeyPath, "-out", publicKeyPath], {
      cwd: serverRoot,
      env: serverEnv,
    });
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
        "--group=org-operations-journeys",
        "--no-interaction",
      ],
      { cwd: serverRoot, env: serverEnv },
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

    await runCommand("bun", ["run", "build:prod"], { cwd: serverRoot, env: serverEnv });
    symfonyProcess = startProcess(
      "php",
      ["-d", "variables_order=EGPCS", "-S", `127.0.0.1:${legacyPort}`, "-t", "public", routerPath],
      { cwd: serverRoot, env: serverEnv },
    );
    await waitForHttp(`${legacyOrigin}/api/docs`, symfonyProcess);

    await runCommand("bun", ["run", "build"], { cwd: sdkRoot, env: dashboardEnv });
    await runCommand("bun", ["run", "build"], { cwd: dashboardRoot, env: dashboardEnv });
    dashboardProcess = startProcess("bun", ["run", "start"], {
      cwd: dashboardRoot,
      env: dashboardEnv,
    });
    await waitForHttp(`${dashboardOrigin}/login`, dashboardProcess);

    const receiptRequested = [
      "RUNTIME_EVIDENCE_RECEIPT_PATH",
      "RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID",
      "RUNTIME_EVIDENCE_MONO_REVISION_REF_ID",
      "RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS",
    ].some((name) => typeof process.env[name] === "string" && process.env[name].length > 0);
    const e2eArgs = [
      resolve(dashboardRoot, "node_modules/@playwright/test/cli.js"),
      "test",
      "e2e/real-symfony-org-operations.spec.ts",
      "--project=real-symfony",
    ];
    if (receiptRequested) e2eArgs.push("--reporter=json");
    const e2eResult = await runCommand(process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node", e2eArgs, {
      cwd: dashboardRoot,
      env: dashboardEnv,
      captureOutput: receiptRequested,
    });

    if (receiptRequested) {
      const runnerSourceRefIds = (process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (runnerSourceRefIds.length !== 2) {
        throw new Error(
          "Runtime evidence requires exactly two runner source references for this runner and spec.",
        );
      }
      await emitRuntimeEvidenceReceipts({
        journeys,
        fixtureId: "hybrid-org-operations-0032.2",
        runnerSourceInputBytes: [
          { sourceRefId: runnerSourceRefIds[0], bytes: await readFile(runnerSourcePath) },
          { sourceRefId: runnerSourceRefIds[1], bytes: await readFile(specSourcePath) },
        ],
        fixtureInputBytes: await hybridFixtureManifestBytes(),
        artifactBytes: sanitizePlaywrightArtifact(e2eResult.stdout),
      });
    }
  } catch (error) {
    primaryError = error;
    primaryFailed = true;
  }

  let cleanupError;
  let cleanupFailed = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
    cleanupFailed = true;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }

  if (cleanupFailed) {
    if (primaryError) {
      console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError);
    } else {
      throw cleanupError;
    }
  }
  if (primaryFailed) throw primaryError;
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
