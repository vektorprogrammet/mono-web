import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { emitRuntimeEvidenceReceipts, sanitizePlaywrightArtifact } from "./runtime-evidence-receipt.mjs";

const dashboardOrigin = "http://127.0.0.1:5174";
const apiOrigin = "http://127.0.0.1:8000";
const journeyRefId = "intent://journey:recruitment:invitation-response:v1";
const journeyStepIds = [
  "applicant-loads-invitation",
  "applicant-confirms-invitation",
  "applicant-rejects-invitation",
  "applicant-requests-new-time",
  "fresh-applicant-response-read",
  "fresh-leader-response-read",
  "fresh-interviewer-response-read",
  "invalid-response-preserves-state",
  "response-capability-remains-private",
];
const defaultJourneyEntries = [
  { journeyRefId, stepIds: journeyStepIds },
  {
    journeyRefId: "intent://journey:parity:applicant_notify_self:v1",
    stepIds: [
      "applicant-notify-self-api-operation",
      "applicant-notify-self-command-write",
      "applicant-notify-self-legacy-route",
      "applicant-notify-self-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:interview_candidate:v1",
    stepIds: [
      "interview-candidate-api-operation",
      "interview-candidate-command-write",
      "interview-candidate-legacy-route",
      "interview-candidate-mono-route",
    ],
  },
];
const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const commandTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const captureOutput = options.captureOutput === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: captureOutput ? ["ignore", "pipe", "inherit"] : ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const stdoutChunks = [];
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (captureOutput) stdoutChunks.push(chunk);
      else stdout += chunk;
    });
    if (!captureOutput) child.stderr.on("data", (chunk) => { stderr += chunk; });
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settle(rejectCommand, new Error(`${command} timed out`));
    }, options.timeoutMs ?? commandTimeoutMs);
    child.once("error", (error) => settle(rejectCommand, error));
    child.once(captureOutput ? "close" : "exit", (code, signal) => {
      if (code === 0) {
        settle(resolveCommand, captureOutput ? { stdout: Buffer.concat(stdoutChunks) } : { stdout, stderr });
        return;
      }
      settle(rejectCommand, new Error(`${command} exited ${code ?? signal}\n${stderr}${stdout}`));
    });
  });
}

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.output = () => output;
  return child;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + commandTimeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`process exited before ${url} was ready: ${child.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}
function redactLogValue(value) {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/((?:password|token|secret|authorization)\s*[:=]\s*)["']?[^"',\s]+/gi, "$1<redacted>");
}

async function reportSymfonyException(logPath) {
  try {
    const records = (await readFile(logPath, "utf8"))
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((record) => record && typeof record === "object");
    const record = records.findLast(
      (candidate) =>
        ["ERROR", "CRITICAL", "ALERT", "EMERGENCY"].includes(
          typeof candidate.level_name === "string" ? candidate.level_name.toUpperCase() : "",
        ) &&
        candidate.context &&
        typeof candidate.context === "object" &&
        candidate.context.exception &&
        typeof candidate.context.exception === "object",
    );
    if (!record) return;
    let exception = record.context.exception;
    while (exception && typeof exception === "object") {
      const className = typeof exception.class === "string" ? exception.class : "Unknown exception";
      const message = typeof exception.message === "string" ? redactLogValue(exception.message) : "";
      console.error(`Symfony e2e exception: ${className}: ${message}`);
      exception = exception.previous;
    }
  } catch {
    // The server can fail before the e2e log handler creates its file.
  }
}

async function assertPortAvailable(port) {
  await new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.once("error", () => rejectPort(new Error(`port ${port} is already in use`)));
    server.listen(port, "127.0.0.1", () => server.close(resolvePort));
  });
}

function assertDisposableDatabase(databasePath, temporaryRoot) {
  const resolvedPath = resolve(databasePath);
  const resolvedRoot = resolve(temporaryRoot);
  if (
    databasePath === ":memory:" ||
    databasePath.includes(":memory:") ||
    resolvedPath.includes("dev.db") ||
    !resolvedPath.startsWith(`${resolvedRoot}/`)
  ) {
    throw new Error(`Refusing non-disposable response e2e database path: ${databasePath}`);
  }
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
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), shutdownTimeoutMs)),
  ]);
  if (graceful || child.exitCode !== null) return;
  signalProcessGroup(child, "SIGKILL");
  await Promise.race([
    exited,
    new Promise((resolvePromise) => setTimeout(resolvePromise, shutdownTimeoutMs)),
  ]);
}

async function main() {
  const temporaryRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mono-web-response-0031-"));
  const databasePath = join(temporaryRoot, "recruitment.sqlite");
  const privateKeyPath = join(temporaryRoot, "jwt-private.pem");
  const publicKeyPath = join(temporaryRoot, "jwt-public.pem");
  const symfonyCacheDir = join(serverRoot, "var/cache/e2e");
  const symfonyLogDir = join(serverRoot, "var/logs/e2e");
  assertDisposableDatabase(databasePath, temporaryRoot);
  const databaseUrl = `sqlite:///${databasePath}`;
  let symfonyProcess;
  let dashboardProcess;

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
  const dashboardEnv = {
    ...process.env,
    API_URL: apiOrigin,
    VITE_API_URL: apiOrigin,
    DASHBOARD_ORIGIN: dashboardOrigin,
    VITE_DASHBOARD_ORIGIN: dashboardOrigin,
    DASHBOARD_INTERVIEW_OWNER: "foldkit",
    VITE_DASHBOARD_INTERVIEW_OWNER: "foldkit",
    REAL_SYMFONY_INTERVIEW_RESPONSE_E2E: "1",
    HOST: "127.0.0.1",
    PORT: "5174",
  };
  delete dashboardEnv.API_MODE;
  delete dashboardEnv.VITE_API_MODE;
  delete dashboardEnv.ALCHEMY_CLOUDFLARE_VITE_INJECTED;

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
    for (const directory of [temporaryRoot, symfonyCacheDir, symfonyLogDir]) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Real Symfony response e2e cleanup failed");
    }
  };
  const handleSignal = (signal) => {
    void cleanup()
      .catch((cleanupError) => console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError))
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
    await runCommand("openssl", ["genrsa", "-out", privateKeyPath, "2048"], { cwd: serverRoot, env: serverEnv });
    await runCommand("openssl", ["rsa", "-pubout", "-in", privateKeyPath, "-out", publicKeyPath], { cwd: serverRoot, env: serverEnv });
    await chmod(privateKeyPath, 0o600);
    await runCommand("php", ["-d", "date.timezone=Europe/Oslo", "bin/console", "doctrine:schema:create", "--env=e2e", "--no-interaction"], { cwd: serverRoot, env: serverEnv });
    await runCommand("php", [
      "-d", "date.timezone=Europe/Oslo", "bin/console", "doctrine:fixtures:load", "--env=e2e",
      "--group=recruitment-interview-invitation-response", "--no-interaction",
    ], { cwd: serverRoot, env: serverEnv });
    const fixtureInputBytes = await readFile(
      join(serverRoot, "tests/Fixtures/RecruitmentInterviewInvitationResponseFixture.php"),
    );
    await assertPortAvailable(8000);
    symfonyProcess = startProcess("php", ["-d", "date.timezone=Europe/Oslo", "-S", "127.0.0.1:8000", "-t", "public", "public/index.php"], { cwd: serverRoot, env: serverEnv });
    await waitForHttp(`${apiOrigin}/api/docs`, symfonyProcess);
    await runCommand("bun", ["run", "build"], { cwd: sdkRoot, env: dashboardEnv });
    await runCommand("bun", ["run", "build"], { cwd: dashboardRoot, env: dashboardEnv });
    await assertPortAvailable(5174);
    dashboardProcess = startProcess("bun", ["run", "start"], { cwd: dashboardRoot, env: dashboardEnv });
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
      "e2e/real-interview-response.spec.ts",
      "--project=real-symfony",
    ];
    if (receiptRequested) e2eArgs.push("--reporter=json");
    const e2eResult = await runCommand(process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node", e2eArgs, {
      cwd: dashboardRoot,
      env: dashboardEnv,
      captureOutput: receiptRequested,
    });
    if (receiptRequested) {
      const runnerSourceInputBytes = [
        {
          sourceRefId: process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS?.split(",")[0]?.trim() ?? "",
          bytes: await readFile(fileURLToPath(new URL("./run-real-interview-response.mjs", import.meta.url))),
        },
        {
          sourceRefId: process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS?.split(",")[1]?.trim() ?? "",
          bytes: await readFile(fileURLToPath(new URL("./real-interview-response.spec.ts", import.meta.url))),
        },
      ];
      const explicitJourneyOverride =
        process.env.RUNTIME_EVIDENCE_JOURNEY_REF_ID !== undefined ||
        process.env.RUNTIME_EVIDENCE_STEP_IDS !== undefined;
      const evidenceJourneys = explicitJourneyOverride
        ? [{
          journeyRefId: process.env.RUNTIME_EVIDENCE_JOURNEY_REF_ID ?? journeyRefId,
          stepIds: process.env.RUNTIME_EVIDENCE_STEP_IDS
            ?.split(",")
            .map((stepId) => stepId.trim())
            .filter((stepId) => stepId.length > 0) ?? journeyStepIds,
        }]
        : defaultJourneyEntries;
      await emitRuntimeEvidenceReceipts({
        journeys: evidenceJourneys,
        fixtureId: "recruitment-invitation-response-0031",
        runnerSourceInputBytes,
        fixtureInputBytes,
        artifactBytes: sanitizePlaywrightArtifact(e2eResult.stdout),
      });
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (primaryError) await reportSymfonyException(join(symfonyLogDir, "e2e.log"));
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
