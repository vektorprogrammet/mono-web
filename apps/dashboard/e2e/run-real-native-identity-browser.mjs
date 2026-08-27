import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const postgresPort = 55465;
const backendPort = 8865;
const dashboardPort = 5265;
const postgresDatabase = "identity_evidence_0065";
const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/${postgresDatabase}`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  "/etc/profiles/per-user/nori/bin/chromium-browser";
const password = process.env.IDENTITY_EVIDENCE_PASSWORD ?? "identity-evidence-password-0065";
const wrongPassword =
  process.env.IDENTITY_EVIDENCE_WRONG_PASSWORD ?? "identity-evidence-wrong-0065";
const secret =
  process.env.IDENTITY_EVIDENCE_AUTH_SECRET ?? "identity-evidence-secret-0065-0123456789";
const timeoutMs = 300_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const detail = (error) => (error instanceof Error ? error.message : String(error));

const assertPortClosed = (port) =>
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

const run = (command, args, options) => {
  const { promise, resolve, reject } = Promise.withResolvers();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
  const stdout = [];
  const stderr = [];
  if (options.capture) {
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
  }
  const timer = setTimeout(() => {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    reject(new Error(`${options.label} timed out`));
  }, timeoutMs);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    const output = {
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
    if (code === 0) resolve(options.capture ? output : undefined);
    else reject(new Error(`${options.label} exited with ${signal ?? `code ${code}`}`));
  });
  return promise;
};

const start = (command, args, env, cwd) =>
  spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });

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

const startRecordingBoundary = async (targetOrigin) => {
  const records = [];
  const server = createServer(async (request, response) => {
    const started = Date.now();
    const method = request.method ?? "GET";
    const target = new URL(request.url ?? "/", targetOrigin);
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const record = {
      direction: "dashboard-to-native-backend",
      destination: "loopback-recording-boundary-to-native-backend",
      method,
      path: target.pathname,
      status: 0,
      durationMs: 0,
    };
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
      const upstream = await fetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
        redirect: "manual",
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      record.status = upstream.status;
      record.durationMs = Date.now() - started;
      response.statusCode = upstream.status;
      if (target.pathname === "/api/me/session") {
        if (upstream.status === 200) {
          const projection = JSON.parse(bytes.toString("utf8"));
          assert.deepEqual(Object.keys(projection).sort(), ["expiresAt", "personId"]);
          assert.equal(projection.personId, "journey-0065-admin");
          assert.ok(
            typeof projection.expiresAt === "string" &&
              Date.parse(projection.expiresAt) > Date.now(),
          );
          record.sessionProjection = {
            personId: projection.personId,
            expiresAt: projection.expiresAt,
          };
        } else if (upstream.status === 401) {
          assert.deepEqual(JSON.parse(bytes.toString("utf8")), {
            error: { tag: "UnauthenticatedActor" },
          });
          record.typedUnauthenticated = true;
        }
      }
      const retryAfter = upstream.headers.get("x-retry-after");
      if (retryAfter !== null && /^\d+$/u.test(retryAfter))
        record.retryAfterSeconds = Number(retryAfter);
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
      response.end();
    }
  });
  const { promise, resolve, reject } = Promise.withResolvers();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.removeListener("error", reject);
    resolve();
  });
  await promise;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    records,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

const main = async () => {
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;
  const selectedPorts = [postgresPort, backendPort, dashboardPort];
  await Promise.all(selectedPorts.map(assertPortClosed));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-native-identity-0065-"));
  const postgresRoot = join(temporaryRoot, "postgres");
  const browserEvidencePath = join(temporaryRoot, "browser-evidence.json");
  let postgres;
  let backend;
  let dashboard;
  let boundary;
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
      {
        cwd: repositoryRoot,
        env: baseEnvironment,
        label: "Identity PostgreSQL initialization",
      },
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
    await waitForHttp(`http://127.0.0.1:${postgresPort}`, postgres, "PostgreSQL").catch(
      async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
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
            return;
          } catch {
            await sleep(250);
          }
        }
        throw new Error("PostgreSQL did not become ready");
      },
    );
    await run(
      "createdb",
      ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres", postgresDatabase],
      { cwd: repositoryRoot, env: baseEnvironment, label: "Identity database creation" },
    );
    const seed = await run("node", ["apps/dashboard/e2e/native-identity-browser-seed.mjs"], {
      cwd: repositoryRoot,
      env: {
        ...baseEnvironment,
        IDENTITY_EVIDENCE_PG_URL: postgresUrl,
        IDENTITY_EVIDENCE_PASSWORD: password,
      },
      capture: true,
      label: "Identity 0065 seed",
    });
    const seedEvidence = JSON.parse(seed.stdout.trim());
    assert.equal(seedEvidence.personId, "journey-0065-admin");
    assert.equal(seedEvidence.migration.revision, 15);
    backend = start(
      "bun",
      ["run", "--cwd", "apps/backend", "start"],
      {
        ...baseEnvironment,
        NODE_ENV: "production",
        BACKEND_HOST: "127.0.0.1",
        BACKEND_PORT: String(backendPort),
        BACKEND_PG_URL: postgresUrl,
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: dashboardOrigin,
        PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      },
      repositoryRoot,
    );
    await waitForHttp(`${backendOrigin}/health`, backend, "Identity backend");
    boundary = await startRecordingBoundary(backendOrigin);
    await run("bun", ["run", "--cwd", "packages/sdk", "build"], {
      cwd: repositoryRoot,
      env: baseEnvironment,
      label: "Identity SDK production build",
    });
    await run("bun", ["run", "--cwd", "apps/dashboard", "build"], {
      cwd: repositoryRoot,
      env: {
        ...baseEnvironment,
        API_URL: boundary.origin,
        VITE_API_URL: boundary.origin,
        DASHBOARD_ORIGIN: dashboardOrigin,
      },
      label: "Identity dashboard production build",
    });
    const dashboardEnvironment = {
      ...baseEnvironment,
      API_URL: boundary.origin,
      VITE_API_URL: boundary.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      REAL_NATIVE_IDENTITY_E2E: "1",
      IDENTITY_EVIDENCE_EMAIL: "admin.identity-0065@example.invalid",
      IDENTITY_EVIDENCE_PASSWORD: password,
      IDENTITY_EVIDENCE_WRONG_PASSWORD: wrongPassword,
      IDENTITY_EVIDENCE_BROWSER_PATH: browserEvidencePath,
    };
    dashboard = start(
      "node",
      ["node_modules/@react-router/serve/bin.cjs", "build/server/index.js"],
      { ...dashboardEnvironment, HOST: "127.0.0.1", PORT: String(dashboardPort) },
      dashboardRoot,
    );
    await waitForHttp(`${dashboardOrigin}/login`, dashboard, "Identity dashboard");
    await run(
      "node",
      [
        "./node_modules/@playwright/test/cli.js",
        "test",
        "e2e/native-identity-browser.spec.ts",
        "--project=chromium",
        "--workers=1",
        "--retries=0",
      ],
      {
        cwd: dashboardRoot,
        env: dashboardEnvironment,
        label: "Identity 0065 Chromium journey",
      },
    );
    const browserEvidence = JSON.parse(await readFile(browserEvidencePath, "utf8"));
    assert.equal(browserEvidence.passed, true);
    const nativeSignIn = boundary.records.filter(
      (entry) => entry.path === "/api/auth/sign-in/email",
    );
    assert.equal(nativeSignIn.length, 11);
    const wrongStatuses = nativeSignIn.slice(-10).map((entry) => entry.status);
    assert.deepEqual(wrongStatuses, [401, 401, 401, 429, 429, 429, 429, 429, 429, 429]);
    assert.ok(nativeSignIn.some((entry) => entry.status === 200));
    const sessionRequests = boundary.records.filter((entry) => entry.path === "/api/me/session");
    assert.ok(sessionRequests.some((entry) => entry.status === 200));
    assert.ok(sessionRequests.some((entry) => entry.status === 401));
    const forbidden = boundary.records.filter((entry) =>
      /symfony|mock\/api|fixtures|\/api\/login|login_check|sso\/login|glemt-passord|reset|verification|jwt|token/u.test(
        entry.path,
      ),
    );
    assert.deepEqual(forbidden, []);
    const proofOutput = await run(
      "bun",
      ["run", "--cwd", "packages/database", "proof:identity-browser"],
      {
        cwd: repositoryRoot,
        env: { ...baseEnvironment, IDENTITY_EVIDENCE_PG_URL: postgresUrl },
        capture: true,
        label: "Identity 0065 PostgreSQL proof",
      },
    );
    const postgresEvidence = JSON.parse(proofOutput.stdout.trim());
    const versions = await Promise.all([
      run("node", ["--version"], {
        cwd: repositoryRoot,
        env: baseEnvironment,
        capture: true,
        label: "Node version",
      }),
      run("bun", ["--version"], {
        cwd: repositoryRoot,
        env: baseEnvironment,
        capture: true,
        label: "Bun version",
      }),
      run("psql", ["--version"], {
        cwd: repositoryRoot,
        env: baseEnvironment,
        capture: true,
        label: "PostgreSQL version",
      }),
      run(chromiumExecutablePath, ["--version"], {
        cwd: dashboardRoot,
        env: baseEnvironment,
        capture: true,
        label: "Chromium version",
      }),
    ]);
    const ledger = [...browserEvidence.requestLedger.browserToDashboard, ...boundary.records];
    evidence = {
      specId: "0065",
      parentSpecId: "0054",
      baseCommit: "2bcc38a605c9c85dcc1be722dff361138c801827",
      finalRevision: (
        await run("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
          env: baseEnvironment,
          capture: true,
          label: "Revision",
        })
      ).stdout.trim(),
      topology: {
        postgres: "fresh-loopback-postgresql",
        backend: backendOrigin,
        dashboard: dashboardOrigin,
        recordingBoundary: boundary.origin,
      },
      versions: {
        node: versions[0].stdout.trim(),
        bun: versions[1].stdout.trim(),
        postgres: versions[2].stdout.trim(),
        chromium: versions[3].stdout.trim(),
        betterAuth: "^1.7.1",
        playwright: "^1.51.1",
      },
      browser: {
        ...browserEvidence,
        engine: "Chromium",
        topology: { baseURL: dashboardOrigin, webServer: "undefined" },
      },
      native: {
        signInStatuses: nativeSignIn.map(({ status }) => status),
        wrongPasswordStatuses: wrongStatuses,
        sessionStatuses: sessionRequests.map(({ status }) => status),
      },
      postgres: postgresEvidence,
      requestLedger: ledger,
      cleanup: { pending: true },
      passed: true,
    };
  } catch (error) {
    failure = error;
  }
  const cleanupErrors = [];
  for (const [label, child] of [
    ["dashboard", dashboard],
    ["backend", backend],
  ]) {
    try {
      await stop(child);
    } catch (error) {
      cleanupErrors.push(new Error(`${label}: ${detail(error)}`));
    }
  }
  try {
    if (postgres !== undefined)
      await run("pg_ctl", ["-D", postgresRoot, "-m", "fast", "-w", "stop"], {
        cwd: repositoryRoot,
        env: baseEnvironment,
        label: "PostgreSQL cleanup",
      });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await boundary?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  const boundaryPort = boundary === undefined ? undefined : Number(new URL(boundary.origin).port);
  const cleanupPorts = [...selectedPorts, ...(boundaryPort === undefined ? [] : [boundaryPort])];
  try {
    await Promise.all(cleanupPorts.map(assertPortClosed));
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (failure !== undefined) throw failure;
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, "Identity evidence cleanup failed");
  assert.ok(evidence);
  evidence.cleanup = {
    temporaryRootRemoved: true,
    portsClosed: cleanupPorts,
    ownedProcessesExited: true,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`Real native Identity runner failed: ${detail(error)}\n`);
  process.exitCode = 1;
});
