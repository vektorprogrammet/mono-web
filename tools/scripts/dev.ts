import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { createRequire } from "node:module";
import process from "node:process";
import { Config, Console, Data, Effect, Match, Option, Path, Schema } from "effect";
import { jobDisposition, runJob } from "./job-process.js";

const usage = `Usage: just dev [--help]

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
Provision the native journey accounts separately with \`just seed\`; see README.md.
Receipt files and database contents persist across restarts.
External delivery is disabled. Queued delivery does not prove mail delivery.
Backend package .env files are disabled; provider environment is not inherited.
Ctrl+C stops the application tasks owned by Turbo, not existing services.
`;

/** A refusal; the launcher prints it and exits 1. */
class DevFailure extends Data.TaggedError("DevFailure")<{ readonly message: string }> {}

const fail = (message: string) => Effect.fail(new DevFailure({ message }));

/** An environment variable, or undefined when it is not set. */
const variable = (name: string) =>
  Effect.map(Config.option(Config.String(name)), Option.getOrUndefined);

const encodeOrigins = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const disposition = jobDisposition();

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const root = path.join(import.meta.dir, "..", "..");
  const args = process.argv.slice(2).filter((argument) => argument !== "--");

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    yield* Console.log(usage.trimEnd());

    return 0;
  }

  if (args.length !== 0) return yield* fail("Unknown argument. Use just dev --help.");

  const postgresUrl = (yield* variable("BACKEND_PG_URL")) ?? "";

  if (postgresUrl === "")
    return yield* fail("Set BACKEND_PG_URL to a dedicated local PostgreSQL database URL.");

  const database = URL.canParse(postgresUrl) ? new URL(postgresUrl) : undefined;

  if (database === undefined) return yield* fail("BACKEND_PG_URL must be a PostgreSQL URL.");

  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    database.pathname.length < 2 ||
    database.search !== "" ||
    database.hash !== "" ||
    (database.port !== "" && (Number(database.port) < 1 || Number(database.port) > 65_535))
  ) {
    return yield* fail(
      "BACKEND_PG_URL must name a loopback PostgreSQL database, without query parameters or fragments.",
    );
  }

  const secret = yield* variable("BETTER_AUTH_SECRET");

  if (secret === undefined || secret.trim().length < 32) {
    return yield* fail("Set BETTER_AUTH_SECRET to at least 32 characters.");
  }

  const port = Effect.fnUntraced(function* (name: string, fallback: number) {
    const raw = (yield* variable(name)) ?? String(fallback);
    const value = Number(raw);

    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
      return yield* fail(`${name} must be an integer from 1 to 65535.`);
    }

    return value;
  });

  const backendPort = yield* port("LOCAL_BACKEND_PORT", 8791);
  const dashboardPort = yield* port("LOCAL_DASHBOARD_PORT", 5173);
  const homepagePort = yield* port("LOCAL_HOMEPAGE_PORT", 8787);

  if (new Set([backendPort, dashboardPort, homepagePort]).size !== 3) {
    return yield* fail(
      "LOCAL_BACKEND_PORT, LOCAL_DASHBOARD_PORT, and LOCAL_HOMEPAGE_PORT must be distinct.",
    );
  }

  const mount = (yield* variable("DASHBOARD_MOUNT")) ?? "/dashboard/";

  if (mount !== "/dashboard/" && mount !== "/")
    return yield* fail("DASHBOARD_MOUNT must be /dashboard/ or /.");

  const receiptRoot = Effect.fnUntraced(function* (name: string, fallback: string) {
    const value = (yield* variable(name)) ?? fallback;

    if (value.trim().length === 0) return yield* fail(`${name} must not be empty.`);

    return path.resolve(root, value);
  });

  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

  // Inherit terminal/tool discovery only, never provider credentials, remote endpoints,
  // PostgreSQL overrides, preload hooks, or release/rehearsal configuration.
  const env: Record<string, string> = {};

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
    const value = yield* variable(key);

    if (value !== undefined) env[key] = value;
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
  NATIVE_IDENTITY_TRUSTED_ORIGINS: encodeOrigins([dashboardOrigin]),
  OAUTH_CANONICAL_ORIGIN: backendOrigin,
  OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  API_URL: backendOrigin,
  VITE_API_URL: dashboardOrigin,
  DASHBOARD_MOUNT: mount,
  RECEIPT_STAGING_ROOT: yield* receiptRoot("RECEIPT_STAGING_ROOT", ".cache/local-dev/receipts/staging"),
  RECEIPT_COMMITTED_ROOT: yield* receiptRoot(
    "RECEIPT_COMMITTED_ROOT",
    ".cache/local-dev/receipts/committed",
  ),
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
  RECRUITMENT_NOTIFICATION_MODE: "disabled",
  SCHOOL_SERVICE_NOTIFICATION_MODE: "disabled",
  TEAM_APPLICATION_DELIVERY_MODE: "disabled",
});

  // Use the installed native Turbo binary directly. Its JavaScript wrapper uses
  // execFileSync, which prevents reliable signal forwarding and can auto-install.
  const require = createRequire(import.meta.url);
  const turboRequire = createRequire(require.resolve("turbo/package.json"));
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const architecture = process.arch === "x64" ? "64" : process.arch;
  const executable = process.platform === "win32" ? "turbo.exe" : "turbo";

  const turbo = yield* Effect.try({
    try: () => turboRequire.resolve(`turbo-${platform}-${architecture}/bin/${executable}`),
    catch: () =>
      new DevFailure({
        message: "The installed Turbo binary is missing. Run bun install before just dev.",
      }),
  });

  yield* Console.log(
    `Homepage: http://127.0.0.1:${homepagePort}\nDashboard: ${dashboardOrigin}${mount}\nBackend: ${backendOrigin}\nExternal delivery: disabled`,
  );

  // Turbo owns task startup, failure cancellation, and descendant shutdown. A signal that this
  // launcher receives goes to Turbo, and the launcher then exits as that signal asks.
  const turboExit = yield* runJob({
    command: turbo,
    arguments: [
      "run",
      "dev",
      "--env-mode=loose",
      "--ui=stream",
      "--no-daemon",
      "--filter=@vektorprogrammet/backend",
      "--filter=@monoweb/homepage",
      "--filter=@monoweb/dashboard",
    ],
    variables: env,
    isolated: true,
    cwd: root,
    forwardedSignals: ["SIGINT", "SIGTERM"],
  }).pipe(Effect.catchTag("JobStartFailure", () => fail("Turbo could not start.")));

  const stoppedBy = turboExit.forwarded ?? turboExit.signal;

  const exitCode = Match.value(stoppedBy).pipe(
    Match.when("SIGINT", () => 130),
    Match.when("SIGTERM", () => 143),
    Match.orElse(() => turboExit.exitCode ?? 1),
  );

  yield* disposition.record({ exitCode, signal: null });

  return exitCode;
}).pipe(
  Effect.catchTag("DevFailure", ({ message }) =>
    Console.error(`Local development: ${message}`).pipe(Effect.as(1)),
  ),
);

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)), {
  teardown: disposition.teardown,
});
