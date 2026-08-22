import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { emitRuntimeEvidenceReceipts, sanitizePlaywrightArtifact } from "./runtime-evidence-receipt.mjs";

const apiOrigin = "http://127.0.0.1:8000";
const apiPort = 8000;
const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const runnerSourcePath = fileURLToPath(new URL("./run-real-content-ops.mjs", import.meta.url));
const specPaths = [
  fileURLToPath(new URL("./real-content-publication.spec.ts", import.meta.url)),
  fileURLToPath(new URL("./real-survey-admin.spec.ts", import.meta.url)),
  fileURLToPath(new URL("./real-platform-ops.spec.ts", import.meta.url)),
  fileURLToPath(new URL("./real-framework-runtime-plumbing.spec.ts", import.meta.url)),
];
const specRelativePaths = [
  "e2e/real-content-publication.spec.ts",
  "e2e/real-survey-admin.spec.ts",
  "e2e/real-platform-ops.spec.ts",
  "e2e/real-framework-runtime-plumbing.spec.ts",
];
const fixturePaths = [
  fileURLToPath(new URL("../../server/tests/Fixtures/ContentPublicationJourneyFixture.php", import.meta.url)),
  fileURLToPath(new URL("../../server/tests/Fixtures/SurveyAdminJourneyFixture.php", import.meta.url)),
  fileURLToPath(new URL("../../server/tests/Fixtures/PlatformOpsJourneyFixture.php", import.meta.url)),
  fileURLToPath(new URL("../../server/tests/Fixtures/FrameworkRuntimePlumbingJourneyFixture.php", import.meta.url)),
];
const fixtureGroups = [
  "content-publication",
  "survey-admin",
  "platform-ops",
  "framework-runtime-plumbing",
];
const commandTimeoutMs = 180_000;
const shutdownTimeoutMs = 5_000;

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", (error) => rejectPromise(new Error(`Loopback port ${port} is unavailable: ${error.message}`)));
    server.listen(port, "127.0.0.1", () => server.close((closeError) => closeError ? rejectPromise(closeError) : resolvePromise()));
  });
}

function requireOpenSsl() {
  const result = spawnSync("openssl", ["version"], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("openssl is required to create disposable e2e JWT keys");
}

function runCommand(command, args, { cwd, env, captureOutput = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const stdout = [];
    const stderr = [];
    if (captureOutput) {
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    }
    const timeout = setTimeout(() => {
      signalProcessGroup(child, "SIGKILL");
      rejectPromise(new Error(`${command} ${args.join(" ")} timed out`));
    }, commandTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})${errorOutput ? `: ${errorOutput.slice(-4000)}` : output ? `: ${output.slice(-4000)}` : ""}`));
    });
  });
}

function startProcess(command, args, { cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + commandTimeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Symfony server exited before ${url} became ready`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError})` : ""}`);
}

function signalProcessGroup(child, signal) {
  if (!child || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function stopProcess(child) {
  if (!child || child.pid === undefined) return;
  if (child.exitCode !== null) return;
  let resolveExit;
  const exited = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
    child.once("exit", resolvePromise);
  });
  signalProcessGroup(child, "SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), sleep(shutdownTimeoutMs).then(() => false)]);
  if (graceful || child.exitCode !== null) return;
  signalProcessGroup(child, "SIGKILL");
  await Promise.race([exited, sleep(shutdownTimeoutMs).then(() => undefined)]);
  if (resolveExit) child.removeListener("exit", resolveExit);
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
  if (!databaseUrl.startsWith(prefix)) throw new Error(`Refusing non-SQLite e2e database URL: ${databaseUrl}`);
  assertDisposableDatabase(databaseUrl.slice(prefix.length), temporaryRoot);
}

async function main() {
  requireOpenSsl();
  await assertPortAvailable(apiPort);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-content-ops-0032-"));
  const databasePath = join(temporaryRoot, "content-ops.sqlite");
  const privateKeyPath = join(temporaryRoot, "jwt-private.pem");
  const publicKeyPath = join(temporaryRoot, "jwt-public.pem");
  const routerPath = join(temporaryRoot, "router.php");
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
    REAL_SYMFONY_CONTENT_OPS_E2E: "1",
    API_URL: apiOrigin,
    VITE_API_URL: apiOrigin,
    API_MODE: "",
    VITE_API_MODE: "",
  };
  delete dashboardEnv.DASHBOARD_CUTOVER_FIXTURE_SEED;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const cleanupErrors = [];
    try {
      await stopProcess(symfonyProcess);
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const directory of [temporaryRoot, symfonyCacheDir, symfonyLogDir, symfonySessionDir, playwrightResultsDir, playwrightReportDir]) {
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
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Real Symfony content operations cleanup failed");
  };

  const handleSignal = (signal) => {
    void cleanup()
      .catch((error) => console.error(error instanceof Error ? error.message : error))
      .finally(() => { process.exitCode = signal === "SIGINT" ? 130 : 143; });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  let primaryError;
  try {
    await rm(symfonyCacheDir, { recursive: true, force: true });
    await rm(symfonyLogDir, { recursive: true, force: true });
    await runCommand("openssl", ["genrsa", "-out", privateKeyPath, "2048"], { cwd: serverRoot, env: serverEnv });
    await runCommand("openssl", ["rsa", "-pubout", "-in", privateKeyPath, "-out", publicKeyPath], { cwd: serverRoot, env: serverEnv });
    await chmod(privateKeyPath, 0o600);

    await runCommand("php", ["bin/console", "doctrine:schema:create", "--env=e2e", "--no-interaction"], { cwd: serverRoot, env: serverEnv });
    const fixtureArgs = ["bin/console", "doctrine:fixtures:load", "--env=e2e", "--no-interaction"];
    for (const group of fixtureGroups) fixtureArgs.push(`--group=${group}`);
    await runCommand("php", fixtureArgs, { cwd: serverRoot, env: serverEnv });

    const fixtureInputBytes = Buffer.concat(await Promise.all(fixturePaths.map((path) => readFile(path))));
    await writeFile(routerPath, `<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (is_string($path) && is_file($_SERVER['DOCUMENT_ROOT'].$path)) {
    return false;
}
require $_SERVER['DOCUMENT_ROOT'].'/index.php';
`, "utf8");

    await runCommand("bun", ["run", "build:prod"], { cwd: serverRoot, env: serverEnv });
    symfonyProcess = startProcess("php", ["-d", "variables_order=EGPCS", "-S", `${apiOrigin.replace("http://", "")}`, "-t", "public", routerPath], { cwd: serverRoot, env: serverEnv });
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
      ...specRelativePaths,
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
      if (runnerSourceRefIds.length !== specPaths.length + 1) {
        throw new Error(`Runtime evidence requires exactly ${specPaths.length + 1} runner source references for this batch runner and its specs.`);
      }
      const runnerSourceInputBytes = await Promise.all([
        (async () => ({
          sourceRefId: runnerSourceRefIds[0],
          bytes: await readFile(runnerSourcePath),
        }))(),
        ...specPaths.map(async (path, index) => ({
          sourceRefId: runnerSourceRefIds[index + 1],
          bytes: await readFile(path),
        })),
      ]);
      const journeys = [
        {
          journeyRefId: "intent://journey:parity:content_publication:v1",
          stepIds: [
            "content-publication-api-operation",
            "content-publication-command-write",
            "content-publication-legacy-route",
            "content-publication-mono-route",
          ],
        },
        {
          journeyRefId: "intent://journey:parity:survey_admin:v1",
          stepIds: [
            "survey-admin-api-operation",
            "survey-admin-command-write",
            "survey-admin-legacy-route",
            "survey-admin-mono-route",
          ],
        },
        {
          journeyRefId: "intent://journey:parity:platform_ops:v1",
          stepIds: [
            "platform-ops-api-operation",
            "platform-ops-command-write",
            "platform-ops-legacy-route",
            "platform-ops-mono-route",
          ],
        },
        {
          journeyRefId: "intent://journey:parity:framework_runtime_plumbing:v1",
          stepIds: [
            "framework-runtime-plumbing-api-operation",
            "framework-runtime-plumbing-mono-route",
          ],
        },
      ];
      await emitRuntimeEvidenceReceipts({
        journeys,
        fixtureId: "content-ops-journeys-0032",
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
      if (primaryError) console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError);
      else throw cleanupError;
    }
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

if (process.versions.bun === undefined) {
  const result = spawnSync("bun", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
