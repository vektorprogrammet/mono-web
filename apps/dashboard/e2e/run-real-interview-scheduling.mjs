import { chmod, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dashboardOrigin = "http://127.0.0.1:5174";
const apiOrigin = "http://127.0.0.1:8000";
const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const commandTimeoutMs = 120_000;
const shutdownTimeoutMs = 5_000;

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

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
    throw new Error(
      "Missing prerequisite: openssl must be installed and available on PATH for disposable JWT key generation.",
    );
  }
}

function runCommand(command, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
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
    child.once("exit", (code, signal) => {
      if (code === 0) {
        settle(resolveCommand);
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
    if (child.exitCode !== null) throw new Error(`Server exited before readiness at ${url}`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
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
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-scheduling-0029-"));
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
  assertDisposableDatabaseUrl(serverEnv.DATABASE_URL, temporaryRoot);
  assertDisposableDatabaseUrl(serverEnv.E2E_DATABASE_URL, temporaryRoot);

  const dashboardEnv = { ...process.env };
  delete dashboardEnv.API_MODE;
  delete dashboardEnv.VITE_API_MODE;
  delete dashboardEnv.ALCHEMY_CLOUDFLARE_VITE_INJECTED;
  dashboardEnv.REAL_SYMFONY_INTERVIEW_SCHEDULING_E2E = "1";
  dashboardEnv.API_URL = apiOrigin;
  dashboardEnv.VITE_API_URL = apiOrigin;
  dashboardEnv.DASHBOARD_ORIGIN = dashboardOrigin;
  dashboardEnv.VITE_DASHBOARD_ORIGIN = dashboardOrigin;
  dashboardEnv.DASHBOARD_INTERVIEW_OWNER = "foldkit";
  dashboardEnv.HOST = "127.0.0.1";
  dashboardEnv.PORT = "5174";
  dashboardEnv.VITE_DASHBOARD_INTERVIEW_OWNER = "foldkit";

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
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Real Symfony e2e cleanup failed");
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
      ["-d", "date.timezone=Europe/Oslo", "bin/console", "doctrine:schema:create", "--env=e2e", "--no-interaction"],
      {
        cwd: serverRoot,
        env: serverEnv,
      },
    );
    await runCommand(
      "php",
      [
        "-d",
        "date.timezone=Europe/Oslo",
        "bin/console",
        "doctrine:fixtures:load",
        "--env=e2e",
        "--group=recruitment-interview-scheduling",
        "--no-interaction",
      ],
      { cwd: serverRoot, env: serverEnv },
    );
    await assertPortAvailable(8000);

    symfonyProcess = startProcess(
      "php",
      ["-d", "date.timezone=Europe/Oslo", "-S", "127.0.0.1:8000", "-t", "public", "public/index.php"],
      {
        cwd: serverRoot,
        env: serverEnv,
      },
    );
    await waitForHttp(`${apiOrigin}/api/docs`, symfonyProcess);
    await runCommand("bun", ["run", "build"], { cwd: sdkRoot, env: dashboardEnv });
    await runCommand("bun", ["run", "build"], { cwd: dashboardRoot, env: dashboardEnv });

    await assertPortAvailable(5174);
    dashboardProcess = startProcess(
      "bun",
      ["run", "start"],
      {
        cwd: dashboardRoot,
        env: dashboardEnv,
      },
    );
    await waitForHttp(`${dashboardOrigin}/login`, dashboardProcess);

    await runCommand(
      "bun",
      ["run", "e2e:test", "--", "e2e/real-interview-scheduling.spec.ts", "--project=real-symfony"],
      { cwd: dashboardRoot, env: dashboardEnv },
    );
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
