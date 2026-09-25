import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import { dashboardBuildInventory, sha256 } from "./golden-school-service-evidence.mjs";
import {
  people,
  fixture,
  seedReimbursement,
  createReimbursementObserver,
  reimbursementSteps,
} from "./golden-reimbursement-evidence.mjs";
import { runReimbursementBrowser } from "../../apps/dashboard/e2e/golden-reimbursement-browser.mjs";

const root = new URL("../../", import.meta.url).pathname;

const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);

const { Pool } = requireDatabase("pg");

const safeEnvironment = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "LD_LIBRARY_PATH",
    "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
    "PLAYWRIGHT_NODE_EXECUTABLE",
    "PLAYWRIGHT_BROWSERS_PATH",
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
);

const command = (binary, args) =>
  execFileSync(binary, args, {
    cwd: root,
    env: safeEnvironment,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

assert.equal(process.argv.length, 2, "Usage: bun --no-env-file tools/e2e/golden-reimbursement.mjs");

assert.equal(
  command("git", ["status", "--porcelain"]).trim(),
  "",
  "requires committed clean source",
);

const revision = command("git", ["rev-parse", "HEAD"]).trim();

const sourceTree = command("git", ["rev-parse", "HEAD^{tree}"]).trim();

const artifactRoot = await mkdtemp(join(tmpdir(), "vektor-reimbursement-"));

const privateRoot = join(artifactRoot, "private");

await mkdir(privateRoot, { mode: 0o700 });

process.stdout.write(`artifacts: ${artifactRoot}\nrunner-pid: ${process.pid}\n`);

const password = randomBytes(24).toString("hex");

const token = randomBytes(24).toString("hex");

const secret = randomBytes(32).toString("hex");

const persons = people(password);

const secrets = [password, token, secret];

const sanitize = (value) =>
  secrets
    .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), String(value))
    .replace(/(authorization|cookie|set-cookie)([\s"':=]+)[^\r\n,}]+/gi, "$1$2[REDACTED]");

const abort = new AbortController();

const children = [];

const ports = [];

const resourceSnapshots = [];

const providerAttempts = [];

let provider;

let pool;

let browser;

let backend;

let observer;

let browserEvidence;

let failure;

let interruption;

let deliveryMode = "accept";

let activeDeliveries = 0;

let maxActiveDeliveries = 0;

let cleanupPromise;

const fault = process.env.GOLDEN_REIMBURSEMENT_FAULT;

assert.ok(
  fault === undefined || ["after-submitted", "interrupt-after-submitted"].includes(fault),
  "unknown journey fault",
);

const eventually = async (label, inspect, timeout = 30_000) => {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    abort.signal.throwIfAborted();

    if (await inspect()) return;
    await pause(50, undefined, { signal: abort.signal });
  }

  throw new Error(`Timed out: ${label}`);
};

const reservePort = async (requested = 0) => {
  const server = createServer();
  const ready = Promise.withResolvers();
  server.once("error", ready.reject);
  server.listen(requested, "127.0.0.1", ready.resolve);
  await ready.promise;
  const port = server.address().port;
  const closed = Promise.withResolvers();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;

  return port;
};

const start = (binary, args, env = safeEnvironment, cwd = root) => {
  abort.signal.throwIfAborted();

  const child = spawn(binary, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const owned = {
    child,
    label: args.includes("apps/backend/src/main.ts") ? "backend" : binary,
    log: "",
  };

  children.push(owned);

  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      owned.log = (owned.log + sanitize(bytes)).slice(-131_072);
    });
  owned.exit = Promise.withResolvers();
  child.once("error", owned.exit.reject);
  child.once("close", (code, signal) => owned.exit.resolve({ code, signal }));

  return owned;
};

const groupAlive = (owned) => {
  if (!owned.child.pid) return false;

  try {
    process.kill(-owned.child.pid, 0);

    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

const signalGroup = (owned, signal) => {
  if (!owned.child.pid) return;

  try {
    process.kill(-owned.child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

// Drain the owned group even when its leader exited, as the school-service CI wrapper does.
const stop = async (owned) => {
  if (!owned) return;
  signalGroup(owned, "SIGTERM");

  for (let count = 0; count < 50 && groupAlive(owned); count++) await pause(100);

  if (groupAlive(owned)) signalGroup(owned, "SIGKILL");

  for (let count = 0; count < 50 && groupAlive(owned); count++) await pause(100);
  assert.equal(groupAlive(owned), false, "owned process group survived cleanup");
};

const run = async (binary, args, env = safeEnvironment, cwd = root, timeout = 120_000) => {
  const owned = start(binary, args, env, cwd);
  const expired = Promise.withResolvers();
  const timer = setTimeout(() => expired.reject(new Error(`${binary} deadline exceeded`)), timeout);

  try {
    const result = await Promise.race([owned.exit.promise, expired.promise]);
    assert.equal(result.code, 0, `${binary} failed: ${owned.log.slice(-6000)}`);

    return owned.log;
  } finally {
    clearTimeout(timer);
    await stop(owned);
  }
};

const sampleResources = (step) => {
  const rows = command("ps", ["-eo", "pid=,ppid=,pgid=,rss=,stat=,comm="])
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, pgid, rssKiB, state, ...name] = line.trim().split(/\s+/);

      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        rssKiB: Number(rssKiB),
        state,
        name: name.join(" "),
      };
    });

  const ownedIds = new Set([process.pid]);

  for (let count = 0; count < 16; count++) {
    const before = ownedIds.size;

    for (const row of rows) if (ownedIds.has(row.ppid)) ownedIds.add(row.pid);

    if (before === ownedIds.size) break;
  }

  const processes = rows.filter((row) => ownedIds.has(row.pid) && row.name !== "ps");
  resourceSnapshots.push({
    step,
    observedAt: new Date().toISOString(),
    scope: "runner and live descendants; point-in-time RSS, not a peak",
    processes,
    processCount: processes.length,
    totalRssKiB: processes.reduce((sum, row) => sum + row.rssKiB, 0),
  });
};

const waitHttp = (url, owned) =>
  eventually(
    `HTTP ${new URL(url).pathname}`,
    async () => {
      if (owned.child.exitCode !== null || owned.child.signalCode !== null)
        throw new Error(`runtime exited: ${owned.log.slice(-6000)}`);

      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();

        return response.ok;
      } catch {
        return false;
      }
    },
    60_000,
  );

const onSignal = (signal) => {
  interruption ??= signal;
  failure ??= `Interrupted: ${signal}`;
  abort.abort(new Error(failure));
  void browser?.close().catch(() => {});

  for (const owned of children) if (owned.label !== "postgres") signalGroup(owned, "SIGTERM");
};

process.on("SIGINT", () => onSignal("SIGINT"));

process.on("SIGTERM", () => onSignal("SIGTERM"));

const deadline = setTimeout(() => onSignal("15-minute journey deadline"), 900_000);

const cleanup = () =>
  (cleanupPromise ??= (async () => {
    const errors = [];

    try {
      await browser?.close();
    } catch (error) {
      errors.push(sanitize(error));
    }

    try {
      await provider?.stop(true);
    } catch (error) {
      errors.push(sanitize(error));
    }

    try {
      await pool?.end();
    } catch (error) {
      errors.push(sanitize(error));
    }

    for (const owned of [...children].reverse()) {
      try {
        await stop(owned);
      } catch (error) {
        errors.push(sanitize(error));
      }
    }

    for (const port of ports) {
      try {
        await reservePort(port);
      } catch {
        errors.push(`owned listener ${port} remains`);
      }
    }

    const groupsDrained = children.every((owned) => !groupAlive(owned));

    if (groupsDrained && errors.length === 0)
      await rm(privateRoot, { recursive: true, force: true });
    sampleResources("after-cleanup");
    clearTimeout(deadline);

    return {
      groupsDrained,
      listenersReleased: errors.length === 0,
      privateResourcesRemoved: groupsDrained && errors.length === 0,
      ports: [...ports],
      processes: children.map(({ child, label }) => ({
        pid: child.pid,
        label,
        exitCode: child.exitCode,
        signal: child.signalCode,
      })),
      errors,
    };
  })());

let sources = [];

let build;

try {
  sampleResources("baseline");

  const sourcePaths = command("git", [
    "ls-files",
    "-z",
    "apps/backend",
    "apps/dashboard",
    "packages/domain",
    "packages/database",
    "packages/http-api",
    "packages/sdk",
    "tools/e2e",
  ])
    .split("\0")
    .filter(Boolean);

  for (const path of sourcePaths)
    sources.push({ path, sha256: sha256(await readFile(join(root, path))) });

  const [pgPort, apiPort, dashboardPort, providerPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
    reservePort(),
  ]);

  ports.push(pgPort, apiPort, dashboardPort, providerPort);
  assert.equal(new Set(ports).size, ports.length);

  const origins = {
    backend: `http://127.0.0.1:${apiPort}`,
    dashboard: `http://127.0.0.1:${dashboardPort}`,
  };

  const postgresUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
  const pgRoot = join(privateRoot, "postgres");
  await run("initdb", [
    "-D",
    pgRoot,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  start("postgres", [
    "-D",
    pgRoot,
    "-p",
    String(pgPort),
    "-h",
    "127.0.0.1",
    "-k",
    privateRoot,
    "-c",
    "max_connections=16",
  ]);
  pool = new Pool({
    connectionString: postgresUrl,
    max: 2,
    connectionTimeoutMillis: 1000,
    statement_timeout: 10_000,
    application_name: "reimbursement-independent-observer",
  });
  await eventually("PostgreSQL ready", async () => {
    try {
      await pool.query("SELECT 1");

      return true;
    } catch {
      return false;
    }
  });
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: providerPort,
    maxRequestBodySize: 65_536,
    async fetch(request) {
      activeDeliveries++;
      maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
      const startedAt = Date.now();
      let attempt;

      try {
        assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
        const body = Buffer.from(await request.arrayBuffer());
        assert.ok(body.length <= 65_536, "bounded synthetic provider envelope");
        const envelope = JSON.parse(body);
        assert.equal(request.headers.get("idempotency-key"), envelope.deliveryId);
        attempt = {
          deliveryId: envelope.deliveryId,
          envelopeSha256: sha256(body),
          startedAt: new Date(startedAt).toISOString(),
          abortedAt: null,
          finishedAt: null,
          status: null,
          elapsedMs: null,
        };
        providerAttempts.push(attempt);
        request.signal.addEventListener(
          "abort",
          () => {
            if (attempt.status === null) attempt.abortedAt = new Date().toISOString();
          },
          { once: true },
        );

        if (deliveryMode === "timeout") await pause(2000, undefined, { signal: request.signal });
        attempt.status = 204;

        return new Response(null, { status: 204 });
      } catch (error) {
        if (attempt) attempt.failure = sanitize(error);

        return new Response(null, { status: 503 });
      } finally {
        if (attempt) {
          attempt.elapsedMs = Date.now() - startedAt;
          attempt.finishedAt = new Date().toISOString();
        }

        activeDeliveries--;
      }
    },
  });

  const backendEnvironment = {
    ...safeEnvironment,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(apiPort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: secret,
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([origins.dashboard]),
    OAUTH_CANONICAL_ORIGIN: origins.backend,
    OAUTH_DASHBOARD_ORIGIN: origins.dashboard,
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    PASSWORD_RESET_DELIVERY_MODE: "disabled",
    RECEIPT_DELIVERY_MODE: "http",
    RECEIPT_DELIVERY_POLL_MS: "250",
    RECEIPT_STAGING_ROOT: join(privateRoot, "staging"),
    RECEIPT_COMMITTED_ROOT: join(privateRoot, "committed"),
    RECEIPT_MAX_FILE_BYTES: "10485760",
    RECEIPT_DELIVERY_URL: `http://127.0.0.1:${providerPort}/receipt`,
    RECEIPT_DELIVERY_TOKEN: token,
    RECEIPT_DELIVERY_TIMEOUT_MS: "500",
    RECEIPT_DELIVERY_SENDER: "finance@example.invalid",
    RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: JSON.stringify({
      [fixture.departmentId]: "finance@example.invalid",
    }),
  };

  await run("bun", ["--no-env-file", "run", "--cwd", "packages/database", "identity:seed"], {
    ...backendEnvironment,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify(Object.values(persons)),
  });
  await seedReimbursement(pool, persons);

  const boot = async () => {
    const environment = { ...backendEnvironment };

    if (environment.RECEIPT_DELIVERY_MODE === "disabled") {
      for (const key of [
        "RECEIPT_DELIVERY_URL",
        "RECEIPT_DELIVERY_TOKEN",
        "RECEIPT_DELIVERY_TIMEOUT_MS",
        "RECEIPT_DELIVERY_SENDER",
        "RECEIPT_DELIVERY_ECONOMY_RECIPIENTS",
      ])
        delete environment[key];
    }

    backend = start("bun", ["--no-env-file", "apps/backend/src/main.ts"], environment);
    await waitHttp(origins.backend + "/health", backend);
  };

  await boot();

  const dashboardEnvironment = {
    ...safeEnvironment,
    API_URL: origins.backend,
    VITE_API_URL: origins.dashboard,
    DASHBOARD_ORIGIN: origins.dashboard,
    DASHBOARD_MOUNT: "/dashboard/",
    HOST: "127.0.0.1",
    PORT: String(dashboardPort),
    NODE_ENV: "production",
    REAL_NATIVE_IDENTITY_E2E: "1",
  };

  await run("bun", ["--no-env-file", "run", "--cwd", "packages/sdk", "build"]);
  const dashboardRoot = join(root, "apps/dashboard");
  await run("bun", ["--no-env-file", "run", "build"], dashboardEnvironment, dashboardRoot, 300_000);
  const files = await dashboardBuildInventory(root);
  build = { revision, sourceTree, digest: "sha256:" + sha256(JSON.stringify(files)), files };

  const dashboard = start(
    "bun",
    ["--no-env-file", "server.mjs"],
    dashboardEnvironment,
    dashboardRoot,
  );

  await waitHttp(origins.dashboard + "/dashboard/login", dashboard);
  observer = createReimbursementObserver(pool, backendEnvironment.RECEIPT_COMMITTED_ROOT, persons);

  const checkpoint = async (step, binding) => {
    const facts = await observer.checkpoint(step, binding);
    sampleResources(step);
    process.stdout.write(`checkpoint: ${step}\n`);

    return facts;
  };

  await checkpoint("initial");
  browserEvidence = await runReimbursementBrowser({
    origins,
    persons,
    artifacts: artifactRoot,
    checkpoint,
    eventually,
    readFacts: observer.read,
    restart: async (mode = "http") => {
      await stop(backend);
      backendEnvironment.RECEIPT_DELIVERY_MODE = mode;
      await boot();
      sampleResources("native-restart");
    },
    providerMode: (mode) => {
      deliveryMode = mode;
    },
    fault,
    browserReady: (value) => {
      browser = value;
    },
  });
  observer.finish();
  sampleResources("bounds-complete");
  const postProbeFacts = await observer.read();
  await writeFile(
    join(artifactRoot, "bounds-evidence.json"),
    JSON.stringify(
      {
        checks: browserEvidence.checks.filter(({ kind }) =>
          [
            "intake",
            "concurrent-disabled-worker",
            "bounded-collection",
            "disabled-worker-recovery",
            "pagination-ui",
          ].includes(kind),
        ),
        facts: {
          ...postProbeFacts,
          outbox: postProbeFacts.outbox.map(({ payload_json, delivery_envelope, ...row }) => ({
            ...row,
            payloadSha256: sha256(JSON.stringify(payload_json)),
            envelopeSha256:
              delivery_envelope === null ? null : sha256(JSON.stringify(delivery_envelope)),
          })),
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  assert.equal(maxActiveDeliveries, 1, "fixed active loopback request concurrency");
  const retried = providerAttempts.filter(({ status }) => status === null);
  assert.ok(retried.length > 0, "notification provider deadline observed");

  for (const attempt of retried) {
    assert.notEqual(attempt.abortedAt, null, "timed-out request cancelled the fixture transport");
    assert.ok(
      attempt.elapsedMs >= 250 && attempt.elapsedMs < 2000,
      "bounded provider deadline interrupted the blocked transport",
    );
    assert.ok(
      providerAttempts.some(
        (candidate) =>
          candidate.deliveryId === attempt.deliveryId &&
          candidate.envelopeSha256 === attempt.envelopeSha256 &&
          candidate.status === 204,
      ),
      "failed immutable envelope recovered unattended",
    );
  }

  assert.equal(command("git", ["rev-parse", "HEAD"]).trim(), revision);
  assert.equal(
    command("git", ["status", "--porcelain"]).trim(),
    "",
    "source changed during acceptance",
  );

  for (const source of sources)
    assert.equal(
      sha256(await readFile(join(root, source.path))),
      source.sha256,
      "source bytes changed during acceptance",
    );
} catch (error) {
  failure ??= sanitize(error instanceof Error ? (error.stack ?? error.message) : error);
}

const cleaned = await cleanup();

if (cleaned.errors.length) failure ??= "Resource cleanup failed";

const evidence = {
  passed: failure === undefined,
  revision,
  sourceTree,
  cleanSource: true,
  environment: "local_disposable",
  failure: failure ?? null,
  interruption: interruption ?? null,
  fault: fault ?? null,
  observations: observer?.observations ?? [],
  browser: browserEvidence ?? null,
  delivery: {
    scope:
      "Active loopback requests; this fixture cancels work on request abort. No remote execution bound is implied.",
    maxActive: maxActiveDeliveries,
    attempts: providerAttempts,
  },
  resources: resourceSnapshots,
  cleanup: cleaned,
};

await writeFile(join(artifactRoot, "evidence.json"), sanitize(JSON.stringify(evidence, null, 2)), {
  mode: 0o600,
});

await writeFile(
  join(artifactRoot, "source-manifest.json"),
  JSON.stringify({ revision, sourceTree, sources }, null, 2),
  { mode: 0o600 },
);

if (build)
  await writeFile(join(artifactRoot, "browser-build.json"), JSON.stringify(build, null, 2), {
    mode: 0o600,
  });

if (failure)
  await writeFile(
    join(artifactRoot, "failure.log"),
    sanitize(children.map(({ label, log }) => `${label}\n${log}`).join("\n")),
    { mode: 0o600 },
  );

const artifacts = [];

for (const name of (await readdir(artifactRoot)).sort()) {
  if (name === "private") continue;
  const bytes = await readFile(join(artifactRoot, name));
  artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}

const receipt = {
  schema_version: "native-functional-journey/v1",
  journey_ref_id: "intent://golden-reimbursement",
  mono_revision_ref_id: "rev-" + revision,
  source_tree: sourceTree,
  clean_source: true,
  environment_kind: "local_disposable",
  result: failure === undefined ? "passed" : "failed",
  exit_code: failure === undefined ? 0 : 1,
  termination_signal: interruption ?? null,
  required_browser: true,
  step_ids: observer?.observations.map(({ step }) => step) ?? [],
  required_step_ids: reimbursementSteps,
  artifact_digest: "sha256:" + sha256(JSON.stringify(artifacts)),
  artifacts,
  runtime: {
    bun: process.versions.bun,
    node: command("node", ["--version"]).trim(),
    postgres: command("postgres", ["--version"]).trim(),
  },
};

await writeFile(join(artifactRoot, "receipt.json"), JSON.stringify(receipt, null, 2), {
  mode: 0o600,
});

process.stdout.write(
  `result: ${receipt.result}\nevidence: ${join(artifactRoot, "receipt.json")}\n`,
);

process.exitCode = receipt.exit_code;
