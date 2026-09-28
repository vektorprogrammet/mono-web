import { Match, Option, Predicate, Schema } from "effect";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reserveLoopbackPorts, startDisposablePostgres } from "@monoweb/postgres";
import { localBackendEnvironment } from "../../../tools/e2e/local-backend-environment.ts";
import { addressesAnyRoute, legacyRoutes } from "./request-routes.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));

const backendRoot = fileURLToPath(new URL("../../backend/", import.meta.url));

const homepageRoot = fileURLToPath(new URL("../../homepage/", import.meta.url));

const [postgresPort, dashboardPort, backendPort, upstreamPort, homepagePort] =
  await reserveLoopbackPorts(5);

const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

const backendOrigin = `http://127.0.0.1:${backendPort}`;

const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;

const homepageOrigin = `http://p000.vektor.phibkro.org:${homepagePort}`;

const homepageListenOrigin = `http://127.0.0.1:${homepagePort}`;

const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/content_e2e_0062`;

const betterAuthSecret = "content-e2e-0062-secret-with-more-than-32-characters";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const withTimeout = (promise, milliseconds, label) =>
  Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new Error(`${label} timed out after ${milliseconds}ms`);
    }),
  ]);

const waitForHttp = (url, label, options) =>
  withTimeout(
    (async () => {
      while (true) {
        const ready = await new Promise((resolve) => {
          const request = httpRequest(url, options, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
          });

          request.once("error", () => resolve(false));
          request.end();
        });

        if (ready) return;
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
    const timeout = setTimeout(() => child.kill("SIGKILL"), 600_000);
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

const copyResponseHeaders = (source, target) => {
  for (const [name, value] of source) {
    if (["connection", "content-length", "set-cookie", "transfer-encoding"].includes(name))
      continue;
    target.setHeader(name, value);
  }

  const cookies = source.getSetCookie();

  if (cookies.length > 0) target.setHeader("Set-Cookie", cookies);
};

const contentUnavailableProblem = {
  type: "urn:vektorprogrammet:problem:v0.2:content.unavailable",
  title: "Content unavailable",
  status: 503,
  code: "content.unavailable",
  detail: "Content data is unavailable.",
};

/** The one RPC request that a request body carries: its id, tag, and payload. */
const RpcRequestBody = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Union([Schema.String, Schema.Int]),
    tag: Schema.String,
    payload: Schema.Unknown,
  }),
);

const parseRpcRequest = (bytes) =>
  bytes === undefined
    ? null
    : Option.getOrNull(Schema.decodeUnknownOption(RpcRequestBody)(bytes.toString("utf8")));

/** The answer that ends one RPC request: a success value, or one failure's error. */
const RpcAnswer = Schema.Tuple([
  Schema.Struct({
    exit: Schema.Union([
      Schema.TaggedStruct("Success", { value: Schema.Unknown }),
      Schema.TaggedStruct("Failure", {
        cause: Schema.Tuple([Schema.Struct({ error: Schema.Unknown })]),
      }),
    ]),
  }),
]);

const ProblemStatus = Schema.Struct({ status: Schema.Int });

/** The registry status of one RPC answer: 200 for a success, its problem's status for a failure. */
const rpcAnswerStatus = (bytes) => {
  let json;

  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }

  return Option.match(Schema.decodeUnknownOption(RpcAnswer)(json), {
    onNone: () => null,
    onSome: ([{ exit }]) =>
      Match.value(exit).pipe(
        Match.tag("Success", () => 200),
        Match.tag("Failure", ({ cause: [{ error }] }) =>
          Option.match(Schema.decodeUnknownOption(ProblemStatus)(error), {
            onNone: () => 500,
            onSome: ({ status }) => status,
          }),
        ),
        Match.exhaustive,
      ),
  });
};

const ExitMessage = Schema.TaggedStruct("Exit", {
  requestId: Schema.Union([Schema.String, Schema.Int]),
  exit: Schema.Unknown,
});

const FailureExit = Schema.TaggedStruct("Failure", { cause: Schema.Array(Schema.Unknown) });

const FailReason = Schema.TaggedStruct("Fail", { error: Schema.Unknown });

/** Answers one RPC request with the content.unavailable problem, as the backend would. */
const sendContentUnavailableRpc = (response, requestId) => {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(
    JSON.stringify([
      ExitMessage.make({
        requestId,
        exit: FailureExit.make({ cause: [FailReason.make({ error: contentUnavailableProblem })] }),
      }),
    ]),
  );
};

const PayloadMembers = Schema.Record(Schema.String, Schema.Unknown);

const payloadMember = (payload, name) =>
  Option.match(Schema.decodeUnknownOption(PayloadMembers)(payload), {
    onNone: () => undefined,
    onSome: (members) => members[name],
  });

/**
 * The HTTP route that each content RPC replaced. The ledger names each RPC by that route, as the
 * command receipts of the backend name it by their normalized target.
 */
const replacedContentRoute = (tag, payload) => {
  const articleId = String(payloadMember(payload, "articleId"));

  switch (tag) {
    case "content.readContentWorkspace":
      return ["GET", "/api/content/articles"];
    case "content.createArticle":
      return ["POST", "/api/content/articles"];
    case "content.readArticle":
      return ["GET", `/api/content/articles/${articleId}`];
    case "content.reviseArticle":
      return ["PATCH", `/api/content/articles/${articleId}`];
    case "content.publishArticle":
      return ["POST", `/api/content/articles/${articleId}:publish`];
    case "content.unpublishArticle":
      return ["POST", `/api/content/articles/${articleId}:unpublish`];
    case "content.listNews":
      return ["GET", "/api/news"];
    case "content.readNewsArticle":
      return ["GET", `/api/news/${String(payloadMember(payload, "slug"))}`];
    default:
      return null;
  }
};

const startRecordingUpstream = async (ledger) => {
  let forcedContentFailure = false;

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const url = new URL(request.url ?? "/", upstreamOrigin);

    const entry = {
      sequence: ledger.length + 1,
      method: request.method ?? "GET",
      pathname: url.pathname,
      search: url.search,
      rpcTag: null,
      forced: false,
      forwardedTo: backendOrigin,
      status: 0,
      durationMilliseconds: 0,
    };

    ledger.push(entry);

    try {
      const body = await requestBody(request);
      const rpcRequest = url.pathname === "/api/rpc" ? parseRpcRequest(body) : null;

      if (rpcRequest !== null) {
        entry.rpcTag = rpcRequest.tag;
        const route = replacedContentRoute(rpcRequest.tag, rpcRequest.payload);

        if (route !== null) [entry.method, entry.pathname] = route;
        const idempotencyKey = payloadMember(rpcRequest.payload, "idempotencyKey");

        if (Predicate.isString(idempotencyKey)) entry.idempotencyKey = idempotencyKey;
        const ifMatch = payloadMember(rpcRequest.payload, "ifMatch");

        if (Predicate.isString(ifMatch)) entry.ifMatch = ifMatch;
        const command = payloadMember(rpcRequest.payload, "request");

        entry.requestFields = Option.match(Schema.decodeUnknownOption(PayloadMembers)(command), {
          onNone: () => [],
          onSome: (members) => Object.keys(members).sort(),
        });
      }

      if (!forcedContentFailure && entry.rpcTag === "content.readContentWorkspace") {
        forcedContentFailure = true;
        entry.forced = true;
        entry.status = 503;
        sendContentUnavailableRpc(response, rpcRequest.id);

        return;
      }

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

      // An RPC answers 200 with its exit; the ledger records the registry status of the exit.
      entry.status =
        entry.rpcTag === null ? upstream.status : (rpcAnswerStatus(responseBytes) ?? upstream.status);
      response.statusCode = upstream.status;
      copyResponseHeaders(upstream.headers, response);
      response.end(responseBytes);
    } catch (cause) {
      entry.status = 502;
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { tag: "ContentPersistenceError" } }));
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

const temporaryRoot = await mkdtemp(join(tmpdir(), "native-content-publication-0062-"));

const browserEvidencePath = join(temporaryRoot, "browser-evidence.json");

const homepageDevVarsPath = join(homepageRoot, ".dev.vars");

let homepageDevVarsCreated = false;

let postgres;

let backend;

let dashboard;

let homepage;

let recordingUpstream;

const ledger = [];

try {
  await writeFile(homepageDevVarsPath, `API_URL=${upstreamOrigin}\n`, { flag: "wx" });
  homepageDevVarsCreated = true;

  postgres = await startDisposablePostgres({ port: postgresPort, database: "content_e2e_0062" });

  const version = postgres.version;

  // Migrations to revision 20_content-publication run inside the backend boot
  // and are additionally proven by the PGlite suite; the seed asserts the
  // five content tables exist before seeding.
  const seed = run("bun", ["e2e/native-content-publication-seed.mjs"], {
    cwd: dashboardRoot,
    env: {
      ...process.env,
      CONTENT_E2E_PG_URL: postgresUrl,
      CONTENT_E2E_DASHBOARD_ORIGIN: dashboardOrigin,
      BETTER_AUTH_SECRET: betterAuthSecret,
    },
    label: "Content deterministic identity and article seed",
  });

  const seedEvidence = JSON.parse(seed.stdout.trim().split("\n").at(-1));
  assert.equal(seedEvidence.passed, true);

  const backendEnvironment = {
    ...process.env,
    ...localBackendEnvironment({ backendOrigin, dashboardOrigin, postgresUrl, betterAuthSecret }),
  };

  backend = start("bun", ["run", "src/main.ts"], {
    cwd: backendRoot,
    env: backendEnvironment,
    label: "Native backend",
  });
  await waitForHttp(`${backendOrigin}/health`, "Native backend startup");

  const offSpecAliasChecks = [];

  for (const { method, pathname, body } of [
    {
      method: "POST",
      pathname: "/api/admin/content",
      body: { operation: "publish", commandId: "alias-1", articleId: 1 },
    },
    { method: "PUT", pathname: "/api/admin/content/drafts/1", body: { commandId: "alias-2" } },
    { method: "PATCH", pathname: "/api/admin/content/drafts/1", body: { commandId: "alias-3" } },
    {
      method: "POST",
      pathname: "/api/admin/content/drafts/1/publish",
      body: { commandId: "alias-4" },
    },
    {
      method: "POST",
      pathname: "/api/admin/content/drafts/1/unpublish",
      body: { commandId: "alias-5" },
    },
    { method: "PATCH", pathname: "/api/admin/content/articles/1", body: { commandId: "alias-6" } },
  ]) {
    const response = await fetch(`${backendOrigin}${pathname}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 404, `${method} ${pathname} must not be served`);
    assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/u);
    assert.deepEqual(await response.json(), {
      type: "urn:vektorprogrammet:problem:v0.2:resource.not-found",
      title: "Resource not found",
      status: 404,
      code: "resource.not-found",
      detail: "The requested resource was not found.",
    });
    offSpecAliasChecks.push({ method, pathname, status: response.status });
  }

  recordingUpstream = await startRecordingUpstream(ledger);
  const upstreamHealth = await fetch(`${upstreamOrigin}/health`);
  assert.equal(upstreamHealth.status, 200, "recording upstream must reach the native backend");

  // The public news surface reads the same authoritative PostgreSQL through
  // the native backend; the homepage worker runs against the recording proxy.
  run("bun", ["run", "worker:build"], {
    cwd: homepageRoot,
    env: { ...process.env, API_URL: upstreamOrigin },
    label: "Homepage production build",
  });
  homepage = start(
    "bunx",
    ["vite", "preview", "--host", "127.0.0.1", "--port", String(homepagePort), "--strictPort"],
    {
      cwd: homepageRoot,
      env: { ...process.env, API_URL: upstreamOrigin },
      label: "Homepage worker",
    },
  );
  await waitForHttp(`${homepageListenOrigin}/`, "Homepage startup", {
    headers: { host: new URL(homepageOrigin).host },
  });

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
    cwd: dashboardRoot,
    env: dashboardEnvironment,
    label: "Content dashboard production build",
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
  await waitForHttp(`${dashboardOrigin}/dashboard/login`, "Dashboard startup");

  const browser = await runAsync(
    "node",
    [
      "./node_modules/@playwright/test/cli.js",
      "test",
      "e2e/native-content-publication.spec.ts",
      "--project=chromium",
      "--reporter=line",
      "--workers=1",
      "--retries=0",
    ],
    {
      cwd: dashboardRoot,
      env: {
        ...dashboardEnvironment,
        REAL_NATIVE_IDENTITY_E2E: "1",
        CONTENT_E2E_BROWSER_EVIDENCE_PATH: browserEvidencePath,
        CONTENT_E2E_HOMEPAGE_ORIGIN: homepageOrigin,
        CONTENT_E2E_API_ORIGIN: upstreamOrigin,
      },
      label: "Native Content Chromium journey",
    },
  );

  const browserEvidence = JSON.parse(await readFile(browserEvidencePath, "utf8"));
  assert.equal(browserEvidence.passed, true);

  const workspaceRequests = ledger.filter(
    (entry) => entry.pathname === "/api/content/articles" && entry.method === "GET",
  );

  const forcedFailures = workspaceRequests.filter((entry) => entry.forced);

  const forwardedSuccesses = workspaceRequests.filter(
    (entry) => !entry.forced && entry.status === 200,
  );

  assert.equal(forcedFailures.length, 1, "one upstream workspace failure must be forced");
  assert.ok(forwardedSuccesses.length >= 3, "retry and staff arc must reach the backend");
  assert.ok(
    ledger.some((entry) => !entry.forced && entry.status === 403),
    "typed authority denials must reach the backend",
  );

  const staffRequests = ledger.filter((entry) =>
    entry.pathname.startsWith("/api/content/articles"),
  );

  // Every staff request is one content RPC, named by the route it replaced; a browser's CORS
  // preflight of the RPC endpoint names none.
  for (const entry of staffRequests) {
    const exact =
      (entry.rpcTag === "content.readContentWorkspace" &&
        entry.method === "GET" &&
        entry.pathname === "/api/content/articles") ||
      (entry.rpcTag === "content.createArticle" && entry.pathname === "/api/content/articles") ||
      (entry.rpcTag === "content.readArticle" &&
        /^\/api\/content\/articles\/\d+$/u.test(entry.pathname)) ||
      (entry.rpcTag === "content.reviseArticle" &&
        /^\/api\/content\/articles\/\d+$/u.test(entry.pathname)) ||
      ((entry.rpcTag === "content.publishArticle" || entry.rpcTag === "content.unpublishArticle") &&
        /^\/api\/content\/articles\/\d+:(?:publish|unpublish)$/u.test(entry.pathname));

    assert.equal(
      exact,
      true,
      "off-spec staff request observed: " + entry.method + " " + entry.pathname,
    );
  }

  assert.deepEqual(
    ledger.filter(
      (entry) =>
        entry.pathname === "/api/rpc" && entry.method !== "OPTIONS" && entry.rpcTag === null,
    ),
    [],
    "every request to the RPC endpoint must carry one RPC request",
  );

  const staffMutations = staffRequests.filter((entry) =>
    [
      "content.createArticle",
      "content.reviseArticle",
      "content.publishArticle",
      "content.unpublishArticle",
    ].includes(entry.rpcTag),
  );

  assert.ok(staffMutations.length >= 3, "staff arc must mutate through the native API");

  for (const mutation of staffMutations) {
    assert.ok(
      mutation.idempotencyKey,
      "missing idempotency key: " + mutation.method + " " + mutation.pathname,
    );

    const createsArticle = mutation.rpcTag === "content.createArticle";

    if (!createsArticle) {
      assert.match(mutation.ifMatch ?? "", /^"vkr2\./u);
    }

    assert.equal(mutation.requestFields?.includes("commandId"), false);
    assert.equal(mutation.requestFields?.includes("expectedRevision"), false);
  }

  assert.deepEqual(
    ledger.filter((entry) => addressesAnyRoute(entry.pathname, legacyRoutes)),
    [],
  );
  assert.equal(process.env.VITE_API_MODE, undefined, "fixture mode must not be enabled");

  const evidence = {
    specId: "0062",
    passed: true,
    postgresVersion: version,
    schemaRevision: "20_content-publication",
    seed: seedEvidence,
    browser: browserEvidence,
    requestLedger: {
      bridgePath: "/dashboard/content",
      workspaceRequests,
      forcedFailures: forcedFailures.length,
      forwardedSuccesses: forwardedSuccesses.length,
      legacyRequests: [],
      fixtureRequests: [],
      offSpecAliasChecks,
      exactStaffRequests: staffRequests,
    },
    playwrightTail: browser.stdout.trim().split("\n").slice(-8),
  };

  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (cause) {
  process.stderr.write(`Content request ledger at failure:\n${JSON.stringify(ledger, null, 2)}\n`);

  if (backend !== undefined) {
    process.stderr.write(`Native backend tail:\n${backend.output.join("")}\n`);
  }

  if (dashboard !== undefined) {
    process.stderr.write(`Dashboard tail:\n${dashboard.output.join("")}\n`);
  }

  if (homepage !== undefined) {
    process.stderr.write(`Homepage tail:\n${homepage.output.join("")}\n`);
  }

  throw cause;
} finally {
  await stop(homepage);
  await stop(dashboard);
  await closeServer(recordingUpstream).catch(() => undefined);
  await stop(backend);
  await postgres?.stop();

  if (homepageDevVarsCreated) await rm(homepageDevVarsPath, { force: true });
  await rm(temporaryRoot, { recursive: true, force: true });
}
