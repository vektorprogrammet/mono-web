import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The parent placement lifecycle driver owns PostgreSQL, seed, backend and credentials.
// This child owns only its production dashboard process and Playwright process.
const root = fileURLToPath(new URL("../../../", import.meta.url));

const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));

const manifestPath = process.env.PLACEMENT_JOURNEY_MANIFEST;

assert.ok(manifestPath, "PLACEMENT_JOURNEY_MANIFEST is required");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

for (const origin of [manifest.backendOrigin, manifest.dashboardOrigin]) {
  const url = new URL(origin);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}

const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });

assert.equal(revision.status, 0);

assert.equal(
  revision.stdout.trim(),
  manifest.revision,
  "browser must build manifest's exact revision",
);

assert.equal(
  spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim(),
  "",
  "browser requires a clean source tree",
);

const environment = {
  ...process.env,
  API_URL: manifest.backendOrigin,
  VITE_API_URL: manifest.dashboardOrigin,
  DASHBOARD_ORIGIN: manifest.dashboardOrigin,
  DASHBOARD_MOUNT: "/dashboard/",
  HOST: "127.0.0.1",
  PORT: new URL(manifest.dashboardOrigin).port,
  NODE_ENV: "production",
  REAL_NATIVE_IDENTITY_E2E: "1",
};

const children = new Set();

let commandSequence = 0;

const run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const logPath = join(manifest.artifacts, `dashboard-command-${++commandSequence}.log`);

    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    children.add(child);
    let output = "";
    child.stdout.on("data", (value) => {
      output += value;
    });
    child.stderr.on("data", (value) => {
      output += value;
    });
    child.once("error", reject);
    child.once("exit", () => children.delete(child));
    child.once("exit", (code) => {
      writeFile(logPath, output, { mode: 0o600 }).then(
        () =>
          code === 0
            ? resolve(output)
            : reject(
                new Error(
                  `${command} ${args.join(" ")} exited ${code}; complete log: ${logPath}\n${output.slice(-6000)}`,
                ),
              ),
        reject,
      );
    });
  });

const stop = async (child) => {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }

  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    "owned dashboard must have exited",
  );
};

const port = Number(new URL(manifest.dashboardOrigin).port);

const reservation = createServer();

await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(port, "127.0.0.1", resolve);
});

await new Promise((resolve) => reservation.close(resolve));

let dashboard;

let output = "";

let failure;

for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    Promise.all([...children, dashboard].map(stop)).then(
      () => process.exit(signal === "SIGTERM" ? 143 : 130),
      () => process.exit(1),
    );
  });

try {
  await run("bun", ["run", "build"], join(root, "packages/sdk"));
  await run("bun", ["run", "build"], dashboardRoot);
  dashboard = spawn("bun", ["server.mjs"], {
    cwd: dashboardRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  dashboard.stdout.on("data", (value) => {
    output += value;
  });
  dashboard.stderr.on("data", (value) => {
    output += value;
  });
  const deadline = Date.now() + 30000;

  while (true) {
    if (dashboard.exitCode !== null) throw new Error(`Dashboard exited: ${output}`);

    try {
      if ((await fetch(`${manifest.dashboardOrigin}/dashboard/login`)).ok) break;
    } catch {}

    assert.ok(Date.now() < deadline, `Dashboard startup timed out: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await run(
    process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "e2e/native-placement.spec.ts",
      "--project=chromium",
      "--workers=1",
      "--retries=0",
      "--reporter=line",
    ],
    dashboardRoot,
  );
} catch (cause) {
  failure = cause;
} finally {
  await Promise.all([...children, dashboard].map(stop));
  await writeFile(join(manifest.artifacts, "dashboard-runtime.log"), output, { mode: 0o600 });
}

if (failure) throw failure;

const evidencePath = join(manifest.artifacts, "browser-evidence.json");

const evidence = JSON.parse(await readFile(evidencePath, "utf8"));

assert.equal(evidence.passed, true);

await writeFile(
  evidencePath,
  JSON.stringify(
    {
      ...evidence,
      cleanup:
        "owned dashboard and Playwright processes exited; database and backend remain with parent driver",
    },
    null,
    2,
  ),
);

process.stdout.write(
  `${JSON.stringify({ passed: true, revision: manifest.revision, evidencePath })}\n`,
);
