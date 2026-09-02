import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const postgresPort = 55446;
const backendPort = 8796;
const dashboardPort = 5194;
const postgresDatabase = "profile_e2e_0064";
const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/${postgresDatabase}`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  "/etc/profiles/per-user/nori/bin/chromium-browser";
const timeoutMs = 300_000;
const secret = "profile-e2e-0064-disposable-secret-0123456789";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const detail = (error) => (error instanceof Error ? error.message : String(error));

const assertPortAvailable = (port) =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`loopback port ${port} is already in use`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error?.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    if (options.capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    const timer = setTimeout(() => {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error(`${options.label} timed out`));
      }
    }, timeoutMs);
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = {
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      };
      if (code === 0) resolve(options.capture ? output : undefined);
      else
        reject(
          new Error(
            `${options.label} exited with ${signal ?? `code ${code}`}${output.stderr ? `: ${output.stderr.slice(-4000)}` : ""}`,
          ),
        );
    });
  });

const start = (command, args, env, cwd) =>
  spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "inherit", "inherit"] });
const stop = async (child) => {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5_000)]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
};
const waitForHttp = async (url, child, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before readiness`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`${label} did not become ready`);
};

const startProxy = async (targetOrigin) => {
  const records = [];
  const server = createServer(async (request, response) => {
    const started = Date.now();
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", targetOrigin).pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const record = { method, path, status: 0, durationMs: 0, direction: "proxy-to-native" };
    records.push(record);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value === undefined ||
          ["connection", "content-length", "host", "transfer-encoding"].includes(name)
        )
          continue;
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      if (method === "PATCH" && path === "/api/profile") await sleep(200);
      const upstream = await fetch(new URL(request.url ?? "/", targetOrigin), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      record.status = upstream.status;
      record.durationMs = Date.now() - started;
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers.entries()) {
        if (["content-encoding", "content-length", "transfer-encoding"].includes(name)) continue;
        if (name === "set-cookie") {
          response.setHeader(name, upstream.headers.getSetCookie());
          continue;
        }
        response.setHeader(name, value);
      }
      response.setHeader("content-length", String(bytes.byteLength));
      response.end(bytes);
    } catch {
      record.status = 502;
      record.durationMs = Date.now() - started;
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "profile evidence proxy failed" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    records,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

const main = async () => {
  await Promise.all([
    assertPortAvailable(postgresPort),
    assertPortAvailable(backendPort),
    assertPortAvailable(dashboardPort),
  ]);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-native-profile-0064-"));
  const postgresRoot = join(temporaryRoot, "postgres");
  const browserEvidencePath = join(temporaryRoot, "browser-evidence.json");
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;
  let postgres;
  let backend;
  let dashboard;
  let proxy;
  let evidence;
  let failure;
  try {
    await run(
      "initdb",
      [
        "-D",
        postgresRoot,
        "--username=postgres",
        "--auth-local=trust",
        "--auth-host=trust",
        "--no-locale",
        "--encoding=UTF8",
      ],
      { cwd: repositoryRoot, env: baseEnvironment, label: "Profile PostgreSQL initialization" },
    );
    postgres = start(
      "pg_ctl",
      [
        "-D",
        postgresRoot,
        "-o",
        `-p ${postgresPort} -h 127.0.0.1 -k ${postgresRoot}`,
        "-l",
        join(postgresRoot, "postgres.log"),
        "-w",
        "start",
      ],
      baseEnvironment,
      repositoryRoot,
    );
    const readyDeadline = Date.now() + 30_000;
    while (Date.now() < readyDeadline) {
      try {
        await run(
          "psql",
          [
            "-h",
            "127.0.0.1",
            "-p",
            String(postgresPort),
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-c",
            "SELECT 1",
          ],
          {
            cwd: repositoryRoot,
            env: baseEnvironment,
            capture: true,
            label: "PostgreSQL readiness",
          },
        );
        break;
      } catch {
        await sleep(250);
      }
    }
    assert.ok(Date.now() < readyDeadline, "PostgreSQL did not become ready");
    await run(
      "createdb",
      ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres", postgresDatabase],
      { cwd: repositoryRoot, env: baseEnvironment, label: "Profile database creation" },
    );
    const seedOutput = await run("node", ["apps/dashboard/e2e/native-profile-self-edit-seed.mjs"], {
      cwd: repositoryRoot,
      env: {
        ...baseEnvironment,
        PROFILE_E2E_PG_URL: postgresUrl,
        PROFILE_E2E_DASHBOARD_ORIGIN: dashboardOrigin,
        BETTER_AUTH_SECRET: secret,
      },
      capture: true,
      label: "Profile evidence seed",
    });
    const seedEvidence = JSON.parse(seedOutput.stdout.trim());
    backend = start(
      "bun",
      ["run", "--cwd", "apps/backend", "start"],
      {
        ...baseEnvironment,
        BACKEND_HOST: "127.0.0.1",
        BACKEND_PORT: String(backendPort),
        BACKEND_PG_URL: postgresUrl,
        BETTER_AUTH_SECRET: secret,
        NATIVE_IDENTITY_DEPLOYMENT: "local",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
        PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      },
      repositoryRoot,
    );
    await waitForHttp(`${backendOrigin}/health`, backend, "native Profile backend");
    proxy = await startProxy(backendOrigin);
    await run("bun", ["run", "--cwd", "apps/dashboard", "build"], {
      cwd: repositoryRoot,
      env: {
        ...baseEnvironment,
        API_URL: proxy.origin,
        VITE_API_URL: proxy.origin,
        DASHBOARD_ORIGIN: dashboardOrigin,
      },
      label: "native Profile dashboard production build",
    });
    const dashboardEnvironment = {
      ...baseEnvironment,
      API_URL: proxy.origin,
      VITE_API_URL: proxy.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      REAL_NATIVE_PROFILE_E2E: "1",
      PROFILE_E2E_API_ORIGIN: proxy.origin,
      PROFILE_E2E_DASHBOARD_ORIGIN: dashboardOrigin,
      PROFILE_E2E_BROWSER_EVIDENCE_PATH: browserEvidencePath,
    };
    dashboard = start(
      "node",
      ["node_modules/@react-router/serve/bin.cjs", "build/server/index.js"],
      { ...dashboardEnvironment, HOST: "127.0.0.1", PORT: String(dashboardPort) },
      dashboardRoot,
    );
    await waitForHttp(`${dashboardOrigin}/login`, dashboard, "native Profile dashboard");
    await run(
      "node",
      [
        "./node_modules/@playwright/test/cli.js",
        "test",
        "e2e/native-profile-self-edit.spec.ts",
        "--project=chromium",
        "--workers=1",
        "--retries=0",
      ],
      { cwd: dashboardRoot, env: dashboardEnvironment, label: "native Profile Chromium journey" },
    );
    const browserEvidence = JSON.parse(await readFile(browserEvidencePath, "utf8"));
    assert.equal(browserEvidence.passed, true);
    assert.equal(browserEvidence.browser, "Chromium");
    assert.deepEqual(browserEvidence.accessibilityViolations, {
      initial: 0,
      invalid: 0,
      success: 0,
      staleConflict: 0,
    });
    assert.deepEqual(browserEvidence.pageErrors, []);
    assert.equal(browserEvidence.requestLedger.forbiddenPaths.length, 0);
    const pgEvidenceOutput = await run(
      "bun",
      ["run", "--cwd", "packages/database", "proof:profile-postgres"],
      {
        cwd: repositoryRoot,
        env: {
          ...baseEnvironment,
          PROFILE_E2E_PG_URL: postgresUrl,
          PROFILE_E2E_EXPECTED_REVISION: "3",
        },
        capture: true,
        label: "Profile PostgreSQL concurrency proof",
      },
    );
    const postgresEvidence = JSON.parse(pgEvidenceOutput.stdout.trim());
    assert.equal(
      postgresEvidence.contenderOutcomes.filter((entry) => entry.outcome.tag === "Success").length,
      1,
    );
    assert.equal(
      postgresEvidence.contenderOutcomes.filter(
        (entry) => entry.outcome.tag === "ProfileStaleRevision",
      ).length,
      1,
    );
    assert.notEqual(
      postgresEvidence.independentConnectionPids[0],
      postgresEvidence.independentConnectionPids[1],
    );
    assert.equal(postgresEvidence.receipt.countForContenders, 1);
    assert.equal(postgresEvidence.replay.byteEqualResult, true);
    assert.equal(postgresEvidence.changedPayloadConflict.tag, "ProfileCommandConflict");
    const ledger = proxy.records.map(({ method, path, status, durationMs, direction }) => ({
      method,
      path,
      status,
      durationMs,
      direction,
    }));
    assert.equal(
      ledger.some(
        (entry) => entry.path === "/api/profile" && entry.method === "GET" && entry.status === 200,
      ),
      true,
    );
    assert.equal(
      ledger.some(
        (entry) => entry.path === "/api/profile" && entry.method === "PATCH" && entry.status === 200,
      ),
      true,
    );
    assert.equal(
      ledger.some((entry) => entry.path === "/api/profile" && entry.status === 401),
      true,
    );
    assert.equal(
      ledger.some((entry) => entry.path === "/api/profile" && entry.status === 422),
      true,
    );
    assert.equal(
      ledger.some((entry) => entry.path === "/api/profile" && entry.status === 409),
      true,
    );
    assert.equal(
      ledger.some((entry) => entry.path === "/api/profile" && entry.status === 412),
      true,
    );
    assert.equal(
      ledger.some((entry) => /symfony|mock\/api|fixtures|\/api\/(?:admin|me)(?:\/|$)/u.test(entry.path)),
      false,
    );
    const versions = await run("node", ["--version"], {
      cwd: repositoryRoot,
      env: baseEnvironment,
      capture: true,
      label: "Node version",
    });
    const bunVersion = await run("bun", ["--version"], {
      cwd: repositoryRoot,
      env: baseEnvironment,
      capture: true,
      label: "Bun version",
    });
    const postgresVersion = await run("psql", ["--version"], {
      cwd: repositoryRoot,
      env: baseEnvironment,
      capture: true,
      label: "PostgreSQL version",
    });
    const chromiumVersion = await run(chromiumExecutablePath, ["--version"], {
      cwd: dashboardRoot,
      env: baseEnvironment,
      capture: true,
      label: "Chromium version",
    });
    const baseCommit = await run("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      env: baseEnvironment,
      capture: true,
      label: "Git base commit",
    });
    const branch = await run("git", ["branch", "--show-current"], {
      cwd: repositoryRoot,
      env: baseEnvironment,
      capture: true,
      label: "Git branch",
    });
    evidence = {
      specId: "0064",
      passed: true,
      baseCommit: baseCommit.stdout.trim(),
      worktree: repositoryRoot,
      branch: branch.stdout.trim() || "detached",
      command: "bun run --cwd apps/dashboard e2e:real-profile",
      topology: {
        postgres: "disposable-loopback-postgresql",
        backend: backendOrigin,
        dashboard: dashboardOrigin,
        proxy: proxy.origin,
        browser: "real-chromium",
      },
      versions: {
        node: versions.stdout.trim(),
        bun: bunVersion.stdout.trim(),
        postgres: postgresVersion.stdout.trim(),
        chromium: chromiumVersion.stdout.trim(),
      },
      seed: seedEvidence,
      browser: browserEvidence,
      postgres: postgresEvidence,
      requestLedger: ledger,
    };
  } catch (error) {
    failure = error;
  }
  const cleanupErrors = [];
  for (const [label, child] of [
    ["dashboard", dashboard],
    ["backend", backend],
    ["postgres", postgres],
  ]) {
    try {
      if (label === "postgres" && child !== undefined)
        await run("pg_ctl", ["-D", postgresRoot, "-m", "fast", "-w", "stop"], {
          cwd: repositoryRoot,
          env: baseEnvironment,
          label: "PostgreSQL cleanup",
        });
      else await stop(child);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await proxy?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  const cleanupPorts = [
    postgresPort,
    backendPort,
    dashboardPort,
    ...(proxy === undefined ? [] : [Number(new URL(proxy.origin).port)]),
  ];
  try {
    await Promise.all(cleanupPorts.map((port) => assertPortAvailable(port)));
  } catch (error) {
    cleanupErrors.push(error);
  }
  let temporaryRootRemoved = false;
  try {
    await access(temporaryRoot);
    cleanupErrors.push(new Error("temporary evidence root was not removed"));
  } catch (error) {
    if (error?.code === "ENOENT") temporaryRootRemoved = true;
    else cleanupErrors.push(error);
  }
  if (failure !== undefined) throw failure;
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, "Profile evidence cleanup failed");
  assert.ok(evidence);
  evidence.cleanup = { temporaryRootRemoved, portsClosed: cleanupPorts };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`Real native Profile runner failed: ${detail(error)}\n`);
  process.exitCode = 1;
});
