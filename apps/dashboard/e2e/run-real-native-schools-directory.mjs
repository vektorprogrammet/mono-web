import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitNativeRuntimeEvidenceReceipts,
  sanitizePlaywrightArtifact,
} from "./runtime-evidence-receipt.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const backendRoot = fileURLToPath(new URL("../../backend/", import.meta.url));
const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const postgresPort = 45160;
const dashboardPort = 45161;
const backendPort = 45162;
const upstreamPort = 45163;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/schools_e2e_0061`;
const betterAuthSecret = "schools-e2e-0061-secret-with-more-than-32-characters";
const runnerPath = fileURLToPath(import.meta.url);
const specPath = join(dashboardRoot, "e2e/native-schools-directory.spec.ts");
const seedPath = join(dashboardRoot, "e2e/native-schools-directory-seed.mjs");
const journeyRefId = "intent://journey:parity:schools_directory:v1";
const journeyStepIds = [
  "schools-directory-api-operation",
  "schools-directory-command-write",
  "schools-directory-mono-route",
];
const receiptEnvironment = [
  "RUNTIME_EVIDENCE_RECEIPT_PATH",
  "RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID",
  "RUNTIME_EVIDENCE_MONO_REVISION_REF_ID",
  "RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS",
];
const receiptRequested = () =>
  receiptEnvironment.some(
    (name) => typeof process.env[name] === "string" && process.env[name].length > 0,
  );

const emitReceipt = async (playwrightOutput) => {
  if (!receiptRequested()) return null;
  return emitNativeRuntimeEvidenceReceipts({
    repositoryRoot,
    sourcePaths: [runnerPath, specPath, seedPath],
    journeys: [{ journeyRefId, stepIds: journeyStepIds }],
    fixtureId: "native-schools-directory-0061",
    fixtureInputBytes: await readFile(seedPath),
    artifactBytes: sanitizePlaywrightArtifact(Buffer.from(playwrightOutput, "utf8")),
  });
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const withTimeout = (promise, milliseconds, label) =>
  Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new Error(`${label} timed out after ${milliseconds}ms`);
    }),
  ]);

const assertPortAvailable = (port) =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", () => reject(new Error(`required port ${port} is already in use`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });

const waitForPort = (port, label) =>
  withTimeout(
    (async () => {
      while (true) {
        const ready = await new Promise((resolve) => {
          const socket = createConnection({ host: "127.0.0.1", port });
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
        });
        if (ready) return;
        await delay(100);
      }
    })(),
    30_000,
    label,
  );

const waitForHttp = (url, label) =>
  withTimeout(
    (async () => {
      while (true) {
        try {
          const response = await fetch(url);
          if (response.status < 500) return;
        } catch {
          // The bounded outer timeout owns failure.
        }
        await delay(150);
      }
    })(),
    60_000,
    label,
  );

const run = (command, args, { cwd = repositoryRoot, env = process.env, label }) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 360_000,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${String(result.status)}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const runAsync = (command, args, { cwd = repositoryRoot, env = process.env, label }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 360_000);
    child.once("error", (cause) => {
      clearTimeout(timeout);
      reject(new Error(`${label} could not start`, { cause }));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${label} failed (${String(code ?? signal)}):\n${stdout}\n${stderr}`));
    });
  });

const start = (command, args, { cwd, env, label }) => {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  const capture = (chunk) => {
    output.push(String(chunk));
    if (output.length > 300) output.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", (code, signal) => {
    if (code !== 0 && signal === null) {
      process.stderr.write(`${label} exited ${String(code)}:\n${output.join("")}\n`);
    }
  });
  return { child, label, output };
};

const stop = async (processHandle) => {
  if (processHandle === undefined || processHandle.child.exitCode !== null) return;
  processHandle.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processHandle.child.once("exit", resolve)),
    delay(5_000).then(() => {
      processHandle.child.kill("SIGKILL");
    }),
  ]);
};

const requestBody = async (request) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error("recording upstream request exceeded 1 MB");
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
};

const parseJsonBody = (bytes) => {
  if (bytes === undefined || bytes.byteLength === 0) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
};

const hasExactKeys = (value, expectedKeys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());

const schoolsUnavailableProblem = {
  type: "urn:vektorprogrammet:problem:v0.2:schools.unavailable",
  title: "Schools unavailable",
  status: 503,
  code: "schools.unavailable",
  detail: "The school directory is temporarily unavailable.",
};

const sendSchoolsUnavailable = (response) => {
  response.writeHead(503, {
    "content-type": "application/problem+json",
    "cache-control": "no-store",
    vary: "Origin",
    "retry-after": "5",
  });
  response.end(JSON.stringify(schoolsUnavailableProblem));
};

const assertProblemResponse = (entry, expected) => {
  const requiredKeys = ["code", "detail", "status", "title", "type"];
  const actualKeys =
    entry.responseJson !== null &&
    typeof entry.responseJson === "object" &&
    !Array.isArray(entry.responseJson)
      ? Object.keys(entry.responseJson).sort()
      : [];
  const allowedKeys = [
    [...requiredKeys].sort(),
    [...requiredKeys, "instance"].sort(),
  ];
  assert.ok(
    allowedKeys.some((keys) => JSON.stringify(keys) === JSON.stringify(actualKeys)),
    `${entry.method} ${entry.pathname} must return a closed RFC 9457 problem`,
  );
  assert.deepEqual(
    {
      type: entry.responseJson.type,
      title: entry.responseJson.title,
      status: entry.responseJson.status,
      code: entry.responseJson.code,
      detail: entry.responseJson.detail,
    },
    expected,
  );
  if ("instance" in entry.responseJson) {
    assert.ok(
      entry.responseJson.instance === null || typeof entry.responseJson.instance === "string",
      "Problem Details instance must be a string or null",
    );
  }
  assert.ok(
    entry.responseContentType?.startsWith("application/problem+json"),
    `${entry.method} ${entry.pathname} must return application/problem+json`,
  );
};

const copyResponseHeaders = (source, target) => {
  for (const [name, value] of source) {
    if (["connection", "content-length", "set-cookie", "transfer-encoding"].includes(name))
      continue;
    target.setHeader(name, value);
  }
  const cookies = source.getSetCookie();
  if (cookies.length > 0) target.setHeader("Set-Cookie", cookies);
};

const startRecordingUpstream = async (ledger) => {
  let forcedSchoolsFailure = false;
  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const pathname = new URL(request.url ?? "/", upstreamOrigin).pathname;
    const entry = {
      sequence: ledger.length + 1,
      method: request.method ?? "GET",
      pathname,
      search: new URL(request.url ?? "/", upstreamOrigin).search,
      forced: false,
      forwardedTo: backendOrigin,
      sessionCookieAuth:
        typeof request.headers.cookie === "string" &&
        request.headers.cookie.includes("better-auth.session_token="),
      authorizationHeaderPresent: request.headers.authorization !== undefined,
      idempotencyKey:
        typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : null,
      ifMatch: typeof request.headers["if-match"] === "string" ? request.headers["if-match"] : null,
      responseContentType: null,
      responseJson: null,
      status: 0,
      durationMilliseconds: 0,
    };
    ledger.push(entry);
    try {
      if (!forcedSchoolsFailure && request.method === "GET" && pathname === "/api/schools") {
        forcedSchoolsFailure = true;
        entry.forced = true;
        entry.status = 503;
        entry.responseContentType = "application/problem+json";
        entry.responseJson = schoolsUnavailableProblem;
        sendSchoolsUnavailable(response);
        return;
      }

      const body = await requestBody(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || ["connection", "content-length", "host"].includes(name))
          continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, value);
        }
      }
      const upstream = await fetch(new URL(request.url ?? "/", backendOrigin), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      entry.status = upstream.status;
      entry.responseContentType = upstream.headers.get("content-type");
      entry.responseJson = parseJsonBody(responseBytes);
      response.statusCode = upstream.status;
      copyResponseHeaders(upstream.headers, response);
      response.end(responseBytes);
    } catch (cause) {
      entry.status = 503;
      entry.responseContentType = "application/problem+json";
      entry.responseJson = schoolsUnavailableProblem;
      sendSchoolsUnavailable(response);
      process.stderr.write(`recording upstream failure: ${String(cause)}\n`);
    } finally {
      entry.durationMilliseconds = Date.now() - startedAt;
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(upstreamPort, "127.0.0.1", resolve);
  });
  return server;
};

const closeServer = (server) =>
  server === undefined
    ? Promise.resolve()
    : new Promise((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      );

const temporaryRoot = await mkdtemp(join(tmpdir(), "native-schools-directory-0061-"));
const postgresData = join(temporaryRoot, "postgres");
const browserEvidencePath = join(temporaryRoot, "browser-evidence.json");
let postgres;
let backend;
let dashboard;
let recordingUpstream;
const ledger = [];

try {
  await Promise.all(
    [postgresPort, dashboardPort, backendPort, upstreamPort].map(assertPortAvailable),
  );
  const version = run("postgres", ["--version"], { label: "PostgreSQL version" }).stdout.trim();
  assert.match(version, /PostgreSQL\) 17\./u, "the Schools journey requires PostgreSQL 17");
  run(
    "initdb",
    ["-D", postgresData, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"],
    { label: "PostgreSQL initialization" },
  );
  postgres = start(
    "postgres",
    ["-D", postgresData, "-p", String(postgresPort), "-h", "127.0.0.1", "-k", temporaryRoot],
    { cwd: repositoryRoot, env: process.env, label: "PostgreSQL 17" },
  );
  await waitForPort(postgresPort, "PostgreSQL 17 startup");
  run(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres", "schools_e2e_0061"],
    { label: "Schools disposable database creation" },
  );

  const proof = run("bun", ["run", "proof:schools-postgres"], {
    cwd: databaseRoot,
    env: { ...process.env, DATABASE_URL: postgresUrl },
    label: "Schools PostgreSQL snapshot proof",
  });
  const proofEvidence = JSON.parse(proof.stdout.trim().split("\n").at(-1));
  assert.equal(proofEvidence.passed, true);
  assert.equal(proofEvidence.database, "PostgreSQL");
  assert.equal(proofEvidence.concurrentMutation.independentConnections, true);

  const seed = run("bun", ["e2e/native-schools-directory-seed.mjs"], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      SCHOOLS_E2E_PG_URL: postgresUrl,
      SCHOOLS_E2E_DASHBOARD_ORIGIN: dashboardOrigin,
      BETTER_AUTH_SECRET: betterAuthSecret,
    },
    label: "Schools deterministic identity and directory seed",
  });
  const seedEvidence = JSON.parse(seed.stdout.trim().split("\n").at(-1));
  assert.equal(seedEvidence.passed, true);

  const backendEnvironment = {
    ...process.env,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: betterAuthSecret,
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    ADMISSION_AUTH_TOKENS: "{}",
    RECEIPT_AUTH_TOKENS: "{}",
    ORGANIZATION_AUTH_TOKENS: "{}",
  };
  backend = start("bun", ["run", "src/main.ts"], {
    cwd: backendRoot,
    env: backendEnvironment,
    label: "Native backend",
  });
  await waitForHttp(`${backendOrigin}/health`, "Native backend startup");

  recordingUpstream = await startRecordingUpstream(ledger);
  const upstreamHealth = await fetch(`${upstreamOrigin}/health`);
  assert.equal(upstreamHealth.status, 200, "recording upstream must reach the native backend");
  const dashboardEnvironment = {
    ...process.env,
    API_URL: upstreamOrigin,
    VITE_API_URL: upstreamOrigin,
    DASHBOARD_ORIGIN: dashboardOrigin,
    HOST: "127.0.0.1",
    PORT: String(dashboardPort),
    NODE_ENV: "production",
  };
  run("bun", ["run", "build"], {
    cwd: sdkRoot,
    env: dashboardEnvironment,
    label: "Schools SDK build",
  });
  run("bun", ["run", "build"], {
    cwd: dashboardRoot,
    env: dashboardEnvironment,
    label: "Schools dashboard production build",
  });
  dashboard = start(
    process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
    ["node_modules/@react-router/serve/dist/cli.js", "build/server/index.js"],
    {
      cwd: dashboardRoot,
      env: dashboardEnvironment,
      label: "Dashboard",
    },
  );
  await waitForHttp(`${dashboardOrigin}/login`, "Dashboard startup");

  const browser = await runAsync(
    "node",
    [
      "./node_modules/@playwright/test/cli.js",
      "test",
      "e2e/native-schools-directory.spec.ts",
      "--project=chromium",
      receiptRequested() ? "--reporter=json" : "--reporter=line",
      "--workers=1",
      "--retries=0",
    ],
    {
      cwd: dashboardRoot,
      env: {
        ...dashboardEnvironment,
        REAL_NATIVE_IDENTITY_E2E: "1",
        SCHOOLS_E2E_BROWSER_EVIDENCE_PATH: browserEvidencePath,
      },
      label: "Native Schools Chromium journey",
    },
  );
  const browserEvidence = JSON.parse(await readFile(browserEvidencePath, "utf8"));
  assert.equal(browserEvidence.passed, true);
  await emitReceipt(browser.stdout);

  const schoolsRequests = ledger.filter((entry) => entry.pathname === "/api/schools");
  const forcedFailures = schoolsRequests.filter((entry) => entry.forced);
  const forwardedSuccesses = schoolsRequests.filter(
    (entry) => !entry.forced && entry.status === 200,
  );
  const authorityDenials = schoolsRequests.filter(
    (entry) => !entry.forced && entry.status === 403,
  );
  assert.equal(forcedFailures.length, 1, "one upstream Schools failure must be forced");
  assert.ok(forwardedSuccesses.length >= 6, "retry and authority matrix must reach the backend");
  assert.ok(authorityDenials.length >= 2, "typed authority denials must reach the backend");
  for (const entry of schoolsRequests) {
    assert.equal(entry.method, "GET", "the native Schools operation is read-only");
    assert.equal(entry.sessionCookieAuth, true, "the native Schools operation requires a session");
    assert.equal(
      entry.authorizationHeaderPresent,
      false,
      "the native Schools operation must not use Authorization",
    );
    assert.equal(entry.idempotencyKey, null, "the native Schools read must not use Idempotency-Key");
    assert.equal(entry.ifMatch, null, "the native Schools read must not use If-Match");
    const queryKeys = [...new URLSearchParams(entry.search).keys()];
    assert.ok(
      queryKeys.length <= 1 && queryKeys.every((key) => key === "department"),
      "the native Schools read used an unsupported query parameter",
    );
  }
  const schoolKeys = [
    "contactPerson",
    "departments",
    "email",
    "isActive",
    "language",
    "name",
    "phone",
    "schoolId",
  ];
  for (const entry of forwardedSuccesses) {
    assert.ok(
      entry.responseContentType?.startsWith("application/json"),
      "the native Schools directory must return application/json",
    );
    assert.ok(
      hasExactKeys(entry.responseJson, ["activeSchools", "inactiveSchools"]),
      "the native Schools directory response did not match the generated shape",
    );
    for (const [collectionName, expectedActive] of [
      ["activeSchools", true],
      ["inactiveSchools", false],
    ]) {
      const schools = entry.responseJson[collectionName];
      assert.ok(Array.isArray(schools), `${collectionName} must be an array`);
      for (const school of schools) {
        assert.ok(hasExactKeys(school, schoolKeys), "a School directory entry had excess fields");
        assert.ok(Number.isInteger(school.schoolId) && school.schoolId > 0);
        assert.equal(school.isActive, expectedActive);
        assert.ok(["Norwegian", "International"].includes(school.language));
        assert.ok(
          ["name", "contactPerson", "email", "phone"].every(
            (key) => typeof school[key] === "string",
          ),
        );
        assert.ok(Array.isArray(school.departments));
        assert.ok(
          school.departments.every(
            (department) =>
              hasExactKeys(department, ["departmentId", "name"]) &&
              typeof department.departmentId === "string" &&
              typeof department.name === "string",
          ),
          "a School department projection did not match the generated shape",
        );
      }
    }
  }
  assertProblemResponse(forcedFailures[0], schoolsUnavailableProblem);
  for (const entry of authorityDenials) {
    assertProblemResponse(entry, {
      type: "urn:vektorprogrammet:problem:v0.2:authority.denied",
      title: "Authority denied",
      status: 403,
      code: "authority.denied",
      detail: "The authenticated principal is not permitted to perform this operation.",
    });
  }
  assert.deepEqual(
    ledger.filter(
      (entry) =>
        entry.pathname === "/api/admin/schools" ||
        entry.pathname.includes("/api/admin/scheduling/schools") ||
        entry.pathname.includes("/kontrollpanel/skoler") ||
        entry.pathname.includes("/mock/api"),
    ),
    [],
  );
  assert.equal(process.env.VITE_API_MODE, undefined, "fixture mode must not be enabled");

  const evidence = {
    specId: "0061",
    passed: true,
    postgresVersion: version,
    proof: proofEvidence,
    seed: seedEvidence,
    browser: browserEvidence,
    requestLedger: {
      bridgePath: "/schools",
      backendPath: "/api/schools",
      schoolsRequests,
      forcedFailures: forcedFailures.length,
      forwardedSuccesses: forwardedSuccesses.length,
      legacyRequests: [],
      fixtureRequests: [],
    },
    playwrightTail: browser.stdout.trim().split("\n").slice(-8),
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (cause) {
  process.stderr.write(`Schools request ledger at failure:\n${JSON.stringify(ledger, null, 2)}\n`);
  if (backend !== undefined) {
    process.stderr.write(`Native backend tail:\n${backend.output.join("")}\n`);
  }
  if (dashboard !== undefined) {
    process.stderr.write(`Dashboard tail:\n${dashboard.output.join("")}\n`);
  }
  throw cause;
} finally {
  await stop(dashboard);
  await closeServer(recordingUpstream).catch(() => undefined);
  await stop(backend);
  await stop(postgres);
  await rm(temporaryRoot, { recursive: true, force: true });
}
