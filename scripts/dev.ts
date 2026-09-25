import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const fail = (message: string): never => {
  process.stderr.write(`Local development: ${message}\n`);
  process.exit(1);
};

const args = process.argv.slice(2).filter((argument) => argument !== "--");

if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(`Usage: bun dev [--help]

\`devenv up\` starts the devenv PostgreSQL service and then this launcher with
BACKEND_PG_URL set to that service's database.

Required environment:
  BACKEND_PG_URL       Dedicated local PostgreSQL database URL.
                      Use postgres:// or postgresql:// with 127.0.0.1,
                      localhost, or [::1]. Query parameters are not allowed.
  BETTER_AUTH_SECRET  At least 32 characters. Keep it stable across restarts.

Optional environment:
  LOCAL_BACKEND_PORT   Default 8791 (8790 can remain in use).
  LOCAL_DASHBOARD_PORT Default 5173.
  LOCAL_HOMEPAGE_PORT  Default 8787.
  DASHBOARD_MOUNT      /dashboard/ (default) or /.
  RECEIPT_STAGING_ROOT   Default .cache/local-dev/receipts/staging.
  RECEIPT_COMMITTED_ROOT Default .cache/local-dev/receipts/committed.
                        Relative paths resolve from the repository root.

All HTTP listeners use 127.0.0.1. Ports must be distinct.
The launcher does not create, reset, or seed a database or accounts.
The backend applies its schema migrations and can write application data.
Use a dedicated database, never a shared database or a production tunnel.
Run the native identity seed separately; see README.md.
Receipt files and database contents persist across restarts.
External delivery is disabled. Queued delivery does not prove mail delivery.
Backend package .env files are disabled; provider environment is not inherited.
Ctrl+C stops the application tasks owned by Turbo, not existing services.
`);
  process.exit(0);
}

if (args.length !== 0) fail("Unknown argument. Use bun dev --help.");

const postgresUrl = process.env.BACKEND_PG_URL;

if (!postgresUrl) fail("Set BACKEND_PG_URL to a dedicated local PostgreSQL database URL.");

let database: URL;

try {
  database = new URL(postgresUrl);
} catch {
  fail("BACKEND_PG_URL must be a PostgreSQL URL.");
}

if (
  !["postgres:", "postgresql:"].includes(database.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
  database.pathname.length < 2 ||
  database.search !== "" ||
  database.hash !== "" ||
  (database.port !== "" && (Number(database.port) < 1 || Number(database.port) > 65_535))
) {
  fail(
    "BACKEND_PG_URL must name a loopback PostgreSQL database, without query parameters or fragments.",
  );
}

const secret = process.env.BETTER_AUTH_SECRET;

if (secret === undefined || secret.trim().length < 32) {
  fail("Set BETTER_AUTH_SECRET to at least 32 characters.");
}

const port = (name: string, fallback: number): number => {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);

  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    fail(`${name} must be an integer from 1 to 65535.`);
  }

  return value;
};

const backendPort = port("LOCAL_BACKEND_PORT", 8791);

const dashboardPort = port("LOCAL_DASHBOARD_PORT", 5173);

const homepagePort = port("LOCAL_HOMEPAGE_PORT", 8787);

if (new Set([backendPort, dashboardPort, homepagePort]).size !== 3) {
  fail("LOCAL_BACKEND_PORT, LOCAL_DASHBOARD_PORT, and LOCAL_HOMEPAGE_PORT must be distinct.");
}

const mount = process.env.DASHBOARD_MOUNT ?? "/dashboard/";

if (mount !== "/dashboard/" && mount !== "/") fail("DASHBOARD_MOUNT must be /dashboard/ or /.");

const receiptRoot = (name: string, fallback: string): string => {
  const value = process.env[name] ?? fallback;

  if (value.trim().length === 0) fail(`${name} must not be empty.`);

  return resolve(root, value);
};

const backendOrigin = `http://127.0.0.1:${backendPort}`;

const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

// Inherit terminal/tool discovery only, never provider credentials, remote endpoints,
// PostgreSQL overrides, preload hooks, or release/rehearsal configuration.
const env: NodeJS.ProcessEnv = {};

for (const key of [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}

Object.assign(env, {
  NODE_ENV: "development",
  TURBO_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
  BACKEND_PG_URL: postgresUrl,
  BETTER_AUTH_SECRET: secret,
  BACKEND_HOST: "127.0.0.1",
  BACKEND_PORT: String(backendPort),
  BACKEND_INGRESS: "external",
  LOCAL_BACKEND_PORT: String(backendPort),
  LOCAL_DASHBOARD_PORT: String(dashboardPort),
  LOCAL_HOMEPAGE_PORT: String(homepagePort),
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
  OAUTH_CANONICAL_ORIGIN: backendOrigin,
  OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  API_URL: backendOrigin,
  VITE_API_URL: dashboardOrigin,
  DASHBOARD_MOUNT: mount,
  RECEIPT_STAGING_ROOT: receiptRoot("RECEIPT_STAGING_ROOT", ".cache/local-dev/receipts/staging"),
  RECEIPT_COMMITTED_ROOT: receiptRoot(
    "RECEIPT_COMMITTED_ROOT",
    ".cache/local-dev/receipts/committed",
  ),
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
  RECRUITMENT_NOTIFICATION_MODE: "disabled",
  SCHOOL_SERVICE_NOTIFICATION_MODE: "disabled",
  SCHOOL_SERVICE_DISPATCH_NOTIFICATION_MODE: "disabled",
  TEAM_APPLICATION_DELIVERY_MODE: "disabled",
});

// Use the installed native Turbo binary directly. Its JavaScript wrapper uses
// execFileSync, which prevents reliable signal forwarding and can auto-install.
const require = createRequire(import.meta.url);

const turboRequire = createRequire(require.resolve("turbo/package.json"));

const platform = process.platform === "win32" ? "windows" : process.platform;

const architecture = process.arch === "x64" ? "64" : process.arch;

const executable = process.platform === "win32" ? "turbo.exe" : "turbo";

let turbo: string;

try {
  turbo = turboRequire.resolve(`turbo-${platform}-${architecture}/bin/${executable}`);
} catch {
  fail("The installed Turbo binary is missing. Run bun install before bun dev.");
}

process.stdout.write(
  `Homepage: http://127.0.0.1:${homepagePort}\nDashboard: ${dashboardOrigin}${mount}\nBackend: ${backendOrigin}\nExternal delivery: disabled\n`,
);

const child = spawn(
  turbo,
  [
    "run",
    "dev",
    "--env-mode=loose",
    "--ui=stream",
    "--no-daemon",
    "--filter=@vektorprogrammet/backend",
    "--filter=@monoweb/homepage",
    "--filter=@monoweb/dashboard",
  ],
  { cwd: root, env, stdio: "inherit" },
);

// Turbo owns task startup, failure cancellation, and descendant shutdown.
let interrupted: NodeJS.Signals | undefined;

const interrupt = (signal: NodeJS.Signals) => {
  interrupted ??= signal;
  child.kill(signal);
};

const sigint = () => interrupt("SIGINT");

const sigterm = () => interrupt("SIGTERM");

process.on("SIGINT", sigint);

process.on("SIGTERM", sigterm);

child.once("error", () => {
  process.stderr.write("Local development: Turbo could not start.\n");
  process.exitCode = 1;
});

child.once("close", (code, signal) => {
  process.off("SIGINT", sigint);
  process.off("SIGTERM", sigterm);
  const stoppedBy = interrupted ?? signal;

  if (stoppedBy === "SIGINT") process.exitCode = 130;
  else if (stoppedBy === "SIGTERM") process.exitCode = 143;
  else process.exitCode = code ?? 1;
});
