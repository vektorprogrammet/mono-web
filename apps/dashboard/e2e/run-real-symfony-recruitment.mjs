import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitRuntimeEvidenceReceipt, sanitizePlaywrightArtifact } from "./runtime-evidence-receipt.mjs";

const dashboardOrigin = "http://127.0.0.1:5174";
const journeyRefId = "intent://journey:recruitment:applicant-assignment:v1";
const journeyStepIds = [
  "assign-interview",
  "fresh-read-applicant-list",
  "load-applicant-list",
  "load-interview-schema-options",
  "load-interviewer-options",
  "mono-session-login",
];
const apiOrigin = "http://127.0.0.1:8000";
const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const commandTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function requireOpenSsl() {
  const result = spawnSync("openssl", ["version"], {
    stdio: "ignore",
  });
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
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, shutdownTimeoutMs);
      hardKill.unref();
      settle(rejectCommand, new Error(`${command} ${args.join(" ")} timed out`));
    }, commandTimeoutMs);
    timeout.unref();
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    child.once("error", (error) => settle(rejectCommand, error));
    child.once(captureOutput ? "close" : "exit", (code, signal) => {
      if (code === 0) {
        settle(resolveCommand, captureOutput ? { stdout: Buffer.concat(stdoutChunks) } : undefined);
        return;
      }
      settle(
        rejectCommand,
        new Error(`${command} ${args.join(" ")} exited with ${signal ? `signal ${signal}` : `code ${code}`}`),
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
      const phpFailure = /\b(?:Warning|Fatal error|Parse error|Notice):/i.test(
        body,
      );
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
  if (child.pid === undefined) return;
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
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "mono-web-proof-0028-"),
  );
  const databasePath = join(temporaryRoot, "recruitment.sqlite");
  const privateKeyPath = join(temporaryRoot, "jwt-private.pem");
  const publicKeyPath = join(temporaryRoot, "jwt-public.pem");
  const symfonyCacheDir = join(serverRoot, "var/cache/e2e");
  const symfonyLogDir = join(serverRoot, "var/logs/e2e");
  assertDisposableDatabase(databasePath, temporaryRoot);
  const databaseUrl = `sqlite:///${databasePath}`;
  let symfonyProcess;
  let dashboardProcess;
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
    CORS_ALLOW_ORIGIN: dashboardOrigin,
    SLACK_DISABLED: "true",
    SMS_DISABLE: "true",
    GOOGLE_API_CLIENT_ID: "e2e-disabled",
    GOOGLE_API_CLIENT_SECRET: "e2e-disabled",
    GOOGLE_API_REFRESH_TOKEN: "e2e-disabled",
    GATEWAY_API_TOKEN: "e2e-disabled",
    DEFAULT_SURVEY_EMAIL: "e2e@example.invalid",
    DEFAULT_FROM_EMAIL: "e2e@example.invalid",
    ECONOMY_EMAIL: "e2e@example.invalid",
    IPINFO_TOKEN: "e2e-disabled",
    GEO_IGNORED_ASNS: "[]",
    LOG_CHANNEL: "e2e",
    SLACK_ENDPOINT: "http://127.0.0.1:9/disabled",
    RECAPTCHA_PUBLIC_KEY: "",
    RECAPTCHA_PRIVATE_KEY: "",
  };
  assertDisposableDatabaseUrl(serverEnv.DATABASE_URL, temporaryRoot);
  assertDisposableDatabaseUrl(serverEnv.E2E_DATABASE_URL, temporaryRoot);

  const dashboardEnv = { ...process.env };
  delete dashboardEnv.API_MODE;
  delete dashboardEnv.VITE_API_MODE;
  delete dashboardEnv.ALCHEMY_CLOUDFLARE_VITE_INJECTED;
  dashboardEnv.REAL_SYMFONY_RECRUITMENT_E2E = "1";
  dashboardEnv.API_URL = apiOrigin;
  dashboardEnv.VITE_API_URL = apiOrigin;
  dashboardEnv.DASHBOARD_ORIGIN = dashboardOrigin;
  dashboardEnv.HOST = "127.0.0.1";
  dashboardEnv.PORT = "5174";

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

    for (const directory of [temporaryRoot, symfonyCacheDir, symfonyLogDir]) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Real Symfony e2e cleanup failed");
    }
  };

  const handleSignal = (signal) => {
    void cleanup()
      .catch((cleanupError) => {
        console.error(
          cleanupError instanceof Error
            ? cleanupError.message
            : cleanupError,
        );
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
        "--group=recruitment-assignment",
        "--no-interaction",
      ],
      { cwd: serverRoot, env: serverEnv },
    );
    const fixtureInputBytes = await readFile(databasePath);

    symfonyProcess = startProcess(
      "php",
      [
        "-d",
        "variables_order=EGPCS",
        "-S",
        "127.0.0.1:8000",
        "-t",
        "public",
        "public/index.php",
      ],
      { cwd: serverRoot, env: serverEnv },
    );
    await waitForHttp(`${apiOrigin}/api/docs`, symfonyProcess);
    await runCommand("bun", ["run", "build"], {
      cwd: sdkRoot,
      env: dashboardEnv,
    });
    await runCommand("bun", ["run", "build"], {
      cwd: dashboardRoot,
      env: dashboardEnv,
    });

    dashboardProcess = startProcess(
      "bun",
      ["run", "start"],
      { cwd: dashboardRoot, env: dashboardEnv },
    );
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
      "e2e/real-symfony-recruitment.spec.ts",
      "--project=real-symfony",
    ];
    if (receiptRequested) e2eArgs.push("--reporter=json");
    const e2eResult = await runCommand(
      process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
      e2eArgs,
      { cwd: dashboardRoot, env: dashboardEnv, captureOutput: receiptRequested },
    );
    if (receiptRequested) {
      const runnerSourceInputBytes = [
        {
          sourceRefId: process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS?.split(",")[0]?.trim() ?? "",
          bytes: await readFile(fileURLToPath(new URL("./run-real-symfony-recruitment.mjs", import.meta.url))),
        },
        {
          sourceRefId: process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS?.split(",")[1]?.trim() ?? "",
          bytes: await readFile(fileURLToPath(new URL("./real-symfony-recruitment.spec.ts", import.meta.url))),
        },
      ];
      const evidenceJourneyRefId = process.env.RUNTIME_EVIDENCE_JOURNEY_REF_ID ?? journeyRefId;
      const evidenceJourneyStepIds = process.env.RUNTIME_EVIDENCE_STEP_IDS
        ?.split(",")
        .map((stepId) => stepId.trim())
        .filter((stepId) => stepId.length > 0) ?? journeyStepIds;
      await emitRuntimeEvidenceReceipt({
        journeyRefId: evidenceJourneyRefId,
        stepIds: evidenceJourneyStepIds,
        fixtureId: "recruitment-assignment-0028",
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
        console.error(
          cleanupError instanceof Error ? cleanupError.message : cleanupError,
        );
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
  const result = spawnSync("bun", [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
