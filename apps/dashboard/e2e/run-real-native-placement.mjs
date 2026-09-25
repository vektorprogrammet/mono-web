import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sanitizePlaywrightArtifact } from "./runtime-evidence-receipt.mjs";
import {
  dashboardBuildInventory,
  sha256,
} from "../../../tools/e2e/golden-school-service-evidence.mjs";

// The parent owns PostgreSQL, fixture, backend and credentials; this child owns dashboard and browser.
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

const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });

assert.equal(status.status, 0);

assert.equal(status.stdout.trim(), "", "browser requires a clean source tree");

const environment = {
  ...Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "TZ",
      "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
      "PLAYWRIGHT_NODE_EXECUTABLE",
      "PLAYWRIGHT_BROWSERS_PATH",
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  ),
  PLACEMENT_JOURNEY_MANIFEST: manifestPath,
  API_URL: manifest.backendOrigin,
  VITE_API_URL: manifest.dashboardOrigin,
  DASHBOARD_ORIGIN: manifest.dashboardOrigin,
  DASHBOARD_MOUNT: manifest.recruitment ? "/" : "/dashboard/",
  HOST: "127.0.0.1",
  PORT: new URL(manifest.dashboardOrigin).port,
  NODE_ENV: "production",
  REAL_NATIVE_IDENTITY_E2E: "1",
  LOCAL_HOMEPAGE_PORT: manifest.homepageOrigin ? new URL(manifest.homepageOrigin).port : undefined,
  GOLDEN_SCHOOL_SERVICE_REQUIRED: manifest.golden ? "1" : "0",
};

const secrets = Object.values(manifest.persons).map((person) => person.password);

const sanitize = (value) =>
  secrets
    .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), String(value))
    .replace(/onboard_[a-f0-9]{64}/g, "[REDACTED]")
    .replace(/(\/interview-response\/)[A-Za-z0-9_-]{43}/g, "$1[REDACTED]")
    .replace(/(authorization|cookie|set-cookie)([\s"':=]+)[^\r\n,}]+/gi, "$1$2[REDACTED]");

const children = new Set();

let commandSequence = 0;

let output = "";

let failure;

let cleanupPromise;

const start = (command, args, cwd, childEnvironment = environment) => {
  const child = spawn(command, args, {
    cwd,
    env: childEnvironment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.add(child);

  if (child.pid && process.env.GOLDEN_PROCESS_GROUPS_PATH)
    appendFileSync(process.env.GOLDEN_PROCESS_GROUPS_PATH, `${child.pid}\n`, { mode: 0o600 });

  return child;
};

const stop = async (child) => {
  if (!child?.pid) return;

  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve));

  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };

  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 3000);

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }

  signal("SIGKILL");
  assert.ok(child.exitCode !== null || child.signalCode !== null, "owned child must have exited");
};

const run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const logPath = join(manifest.artifacts, `dashboard-command-${++commandSequence}.log`);
    const child = start(command, args, cwd);
    let text = "";
    child.stdout.on("data", (value) => {
      text += value;
    });
    child.stderr.on("data", (value) => {
      text += value;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      writeFile(logPath, sanitize(text), { mode: 0o600 }).then(
        () =>
          code === 0
            ? resolve(text)
            : reject(
                new Error(`${command} exited ${code}; ${logPath}\n${sanitize(text).slice(-6000)}`),
              ),
        reject,
      );
    });
  });

const cleanup = () =>
  (cleanupPromise ??= (async () => {
    const cleanupErrors = [];

    for (const result of await Promise.allSettled([...children].map(stop)))
      if (result.status === "rejected") cleanupErrors.push(sanitize(result.reason));
    const traces = [];

    for (const name of await readdir(manifest.artifacts)) {
      if (!/^private-trace-\d+\.zip$/.test(name)) continue;
      const path = join(manifest.artifacts, name);

      try {
        const extracted = spawnSync("unzip", ["-p", path, "*.trace", "*.network"], {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        });

        assert.equal(extracted.status, 0, "failed to extract private diagnostic trace");

        for (const line of extracted.stdout.split("\n")) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          const request = event.snapshot?.request;
          const response = event.snapshot?.response;
          traces.push({
            context: name,
            type: event.type,
            apiName: event.apiName,
            method: event.method ?? request?.method,
            path: request?.url ? new URL(request.url).pathname : undefined,
            status: response?.status,
            error: event.error
              ? sanitize(event.error.message ?? event.error.name ?? "browser action failed")
              : undefined,
          });
        }
      } catch (error) {
        cleanupErrors.push(sanitize(error));
      } finally {
        try {
          await rm(path, { force: true });
        } catch (error) {
          cleanupErrors.push(sanitize(error));
        }
      }
    }

    if (traces.length)
      await writeFile(
        join(manifest.artifacts, "browser-trace-sanitized.json"),
        JSON.stringify(traces, null, 2),
        { mode: 0o600 },
      );
    await rm(join(manifest.artifacts, "playwright-private"), { recursive: true, force: true });
    await rm(join(manifest.artifacts, "homepage-state"), { recursive: true, force: true });
    await writeFile(join(manifest.artifacts, "dashboard-runtime.log"), sanitize(output), {
      mode: 0o600,
    });
    await writeFile(
      join(manifest.artifacts, "browser-cleanup.json"),
      JSON.stringify({
        processesExited: [...children].every(
          (child) => child.exitCode !== null || child.signalCode !== null,
        ),
        processes: [...children].map((child) => ({
          pid: child.pid,
          exited: child.exitCode !== null || child.signalCode !== null,
        })),
        privateTracesRemoved: !(await readdir(manifest.artifacts)).some((name) =>
          name.startsWith("private-trace-"),
        ),
        privateResultsRemoved: true,
        cleanupErrors,
        failure: failure ? sanitize(failure) : null,
      }),
      { mode: 0o600 },
    );

    if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
  })());

for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    failure ??= `Interrupted by ${signal}`;
    void cleanup().then(
      () => process.exit(signal === "SIGTERM" ? 143 : 130),
      () => process.exit(1),
    );
  });

try {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(Number(environment.PORT), "127.0.0.1", resolve);
  });
  await new Promise((resolve) => reservation.close(resolve));
  await run("bun", ["--no-env-file", "run", "build"], join(root, "packages/sdk"));
  await run("bun", ["--no-env-file", "run", "build"], dashboardRoot);

  const sourceTree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(sourceTree.status, 0);
  const files = await dashboardBuildInventory(root);
  await writeFile(
    join(manifest.artifacts, "browser-build.json"),
    JSON.stringify(
      {
        revision: manifest.revision,
        sourceTree: sourceTree.stdout.trim(),
        digest: "sha256:" + sha256(JSON.stringify(files)),
        files,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const dashboard = start(
    "bun",
    [
      "--no-env-file",
      ...(manifest.golden
        ? ["--preload", join(root, "tools/e2e/golden-http-diagnostics.mjs")]
        : []),
      "server.mjs",
    ],
    dashboardRoot,
  );

  dashboard.stdout.on("data", (value) => {
    output += value;
  });
  dashboard.stderr.on("data", (value) => {
    output += value;
  });
  const deadline = Date.now() + 30000;

  while (true) {
    if (dashboard.exitCode !== null) throw new Error(`Dashboard exited: ${sanitize(output)}`);

    try {
      if (
        (
          await fetch(
            `${manifest.dashboardOrigin}${manifest.recruitment ? "/login" : "/dashboard/login"}`,
          )
        ).ok
      )
        break;
    } catch {}

    assert.ok(Date.now() < deadline, `Dashboard startup timed out: ${sanitize(output)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (manifest.recruitment) {
    await run("bun", ["--no-env-file", "run", "worker:build"], join(root, "apps/homepage"));

    const homepage = start(
      environment.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
      [
        join(root, "node_modules/wrangler/bin/wrangler.js"),
        "dev",
        "--local",
        "--config",
        join(root, "apps/homepage/build/server/wrangler.json"),
        "--ip",
        "127.0.0.1",
        "--port",
        new URL(manifest.homepageOrigin).port,
        "--var",
        "API_URL:" + manifest.backendOrigin,
        "--persist-to",
        join(manifest.artifacts, "homepage-state"),
      ],
      root,
      { ...environment, WRANGLER_SEND_METRICS: "false" },
    );

    homepage.stdout.on("data", (value) => {
      output += value;
    });
    homepage.stderr.on("data", (value) => {
      output += value;
    });
    const readyBy = Date.now() + 30000;

    while (true) {
      assert.equal(homepage.exitCode, null, "homepage exited");
      let health;

      try {
        health = await fetch(manifest.homepageOrigin + "/health", {
          headers: { host: "p000.vektor.phibkro.org" },
        });
      } catch {}

      if (health?.ok) {
        assert.equal((await health.json()).commit, manifest.revision, "homepage source differs");
        break;
      }

      assert.ok(Date.now() < readyBy, "homepage startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const report = await run(
    environment.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      manifest.recruitment
        ? "e2e/native-recruitment-first-placement.spec.ts"
        : "e2e/native-placement.spec.ts",
      "--project=chromium",
      "--workers=1",
      "--retries=0",
      "--reporter=json",
      "--grep",
      manifest.recruitment
        ? "continuous recruitment to first placement$"
        : manifest.golden
          ? "golden school-service continuous functional journey$"
          : "0096 placement,",
      "--output",
      join(manifest.artifacts, "playwright-private"),
    ],
    dashboardRoot,
  );

  const sanitized = sanitizePlaywrightArtifact(Buffer.from(report));
  assert.equal(
    JSON.parse(Buffer.from(sanitized).toString()).tests.length,
    1,
    "exactly one required browser scenario must pass",
  );
  await writeFile(join(manifest.artifacts, "playwright-evidence.json"), sanitized, { mode: 0o600 });
  const evidencePath = join(manifest.artifacts, "browser-evidence.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.passed, true, "browser evidence is required even after API success");
  assert.equal(evidence.revision, manifest.revision);
} catch (cause) {
  failure ??= cause;
} finally {
  await cleanup();
}

if (failure) throw new Error(sanitize(failure));

process.stdout.write(
  `${JSON.stringify({ passed: true, revision: manifest.revision, evidencePath: join(manifest.artifacts, "browser-evidence.json") })}\n`,
);
