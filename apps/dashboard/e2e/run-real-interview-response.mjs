import { chmod, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

const dashboardOrigin = "http://127.0.0.1:5174";
const apiOrigin = "http://127.0.0.1:8000";
const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const commandTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectCommand(new Error(`${command} timed out`));
    }, options.timeoutMs ?? commandTimeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectCommand(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolveCommand({ stdout, stderr });
        return;
      }
      rejectCommand(new Error(`${command} exited ${code ?? signal}\n${stderr || stdout}`));
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

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, shutdownTimeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

async function main() {
  const temporaryRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "mono-web-response-0031-"));
  const databasePath = join(temporaryRoot, "recruitment.sqlite");
  const privateKeyPath = join(temporaryRoot, "jwt-private.pem");
  const publicKeyPath = join(temporaryRoot, "jwt-public.pem");
  const symfonyCacheDir = join(serverRoot, "var/cache/e2e-response-0031");
  const symfonyLogDir = join(serverRoot, "var/logs/e2e-response-0031");
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
    await assertPortAvailable(8000);
    symfonyProcess = startProcess("php", ["-d", "date.timezone=Europe/Oslo", "-S", "127.0.0.1:8000", "-t", "public", "public/index.php"], { cwd: serverRoot, env: serverEnv });
    await waitForHttp(`${apiOrigin}/api/docs`, symfonyProcess);
    await runCommand("bun", ["run", "build"], { cwd: sdkRoot, env: dashboardEnv });
    await runCommand("bun", ["run", "build"], { cwd: dashboardRoot, env: dashboardEnv });
    await assertPortAvailable(5174);
    dashboardProcess = startProcess("bun", ["run", "start"], { cwd: dashboardRoot, env: dashboardEnv });
    await waitForHttp(`${dashboardOrigin}/login`, dashboardProcess);
    await runCommand("bun", ["run", "e2e:test", "--", "e2e/real-interview-response.spec.ts", "--project=real-symfony"], { cwd: dashboardRoot, env: dashboardEnv });
  } finally {
    await stopProcess(dashboardProcess);
    await stopProcess(symfonyProcess);
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(symfonyCacheDir, { recursive: true, force: true });
    await rm(symfonyLogDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
