import { NativeProblem, SessionResponse } from "@vektorprogrammet/http-api";
import { Predicate, Schema } from "effect";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { postgresProgram } from "@monoweb/postgres";
import { reserveLoopbackPorts } from "../../../tools/e2e/golden-harness.ts";
import { localBackendEnvironment } from "../../../tools/e2e/local-backend-environment.ts";

/** The owner-only session metadata fields that the API contract defines. */
const sessionFields = Object.keys(SessionResponse.fields).sort();

const credentialProblemCodes = ["credential.missing", "credential.invalid"];

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));

const [postgresPort, backendPort, dashboardPort] = await reserveLoopbackPorts(3);

const postgresDatabase = "identity_evidence_proof_0065";

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

const memberEmail =
  process.env.IDENTITY_EVIDENCE_MEMBER_EMAIL ?? "member.dashboard-0073@example.invalid";

const adminScreenshotPath =
  process.env.IDENTITY_EVIDENCE_ADMIN_SCREENSHOT_PATH ??
  join(tmpdir(), "vektor-dashboard-0073-admin.png");

const memberScreenshotPath =
  process.env.IDENTITY_EVIDENCE_MEMBER_SCREENSHOT_PATH ??
  join(tmpdir(), "vektor-dashboard-0073-member.png");

const timeoutMs = 300_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const detail = (error) => (error instanceof Error ? error.message : String(error));

const sanitizedCommandFailure = (value) =>
  value
    .replaceAll(postgresUrl, "[redacted-loopback-database]")
    .replaceAll(password, "[redacted-password]")
    .replaceAll(wrongPassword, "[redacted-wrong-password]")
    .replaceAll(secret, "[redacted-auth-secret]")
    .slice(-8_000);

const authorityDataPatterns = [
  {
    label: "seeded-authorization-row",
    pattern: /identity-0056-(?:orthogonal|active|expired)/iu,
  },
  {
    label: "seeded-authorization-value",
    pattern:
      /Identity orthogonality 0056|approveReceipt|submitReceipt|EconomyGlobalReceiptApprovalGrant|EconomyPaymentAuthority|synthetic-only-no-secret/iu,
  },
  {
    label: "authorization-table",
    pattern: /authz_(?:tags|tag_assignments|rules)/iu,
  },
  {
    label: "authorization-field",
    pattern:
      /(?:ruleId|rule_id|tagId|tag_id|assignmentId|assignment_id|capabilityId|capability_id|subjectTagId|subject_tag_id)/u,
  },
];

const findAuthorityData = (value) =>
  authorityDataPatterns.flatMap(({ pattern, label }) => (pattern.test(value) ? [label] : []));

const isLegacyOrProviderPath = (path) =>
  /symfony|mock\/api|fixtures|\/api\/login|login_check|sso\/login|glemt-passord|reset|verification|jwt|token/iu.test(
    path,
  ) ||
  (path.startsWith("/api/auth/sign-in/") && path !== "/api/auth/sign-in/email") ||
  /\/api\/auth\/(?:callback|oauth|sso|social|link-social|unlink-account)(?:\/|$)/iu.test(path);

const rememberCookieValue = (values, value) => {
  if (value.length < 8) return;
  values.add(value);

  try {
    values.add(decodeURIComponent(value));
  } catch {}
};

const rememberCookieHeader = (values, header) => {
  if (!Predicate.isString(header)) return;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");

    if (separator >= 0) rememberCookieValue(values, pair.slice(separator + 1).trim());
  }
};

const rememberSetCookie = (values, header) => {
  const pair = header.split(";", 1)[0] ?? "";
  const separator = pair.indexOf("=");

  if (separator >= 0) rememberCookieValue(values, pair.slice(separator + 1).trim());
};

const sanitizationFacts = (candidate, capturedCookieValues) => {
  const serialized = JSON.stringify(candidate);

  const processSecretMatches = [
    ["database-url", postgresUrl],
    ["identity-password", password],
    ["wrong-password", wrongPassword],
    ["better-auth-secret", secret],
  ].flatMap(([label, value]) => (value.length > 0 && serialized.includes(value) ? [label] : []));

  const databaseUrlMatches = /postgres(?:ql)?:\/\//iu.test(serialized) ? ["database-url"] : [];

  const cookieAssignmentMatches = /better-auth\.session_token(?:=|%3D)/iu.test(serialized)
    ? ["session-cookie-assignment"]
    : [];

  const capturedCookieValueMatches = [];

  for (const value of capturedCookieValues) {
    if (value.length > 0 && serialized.includes(value))
      capturedCookieValueMatches.push(`captured-cookie-${capturedCookieValueMatches.length + 1}`);
  }

  assert.deepEqual(processSecretMatches, []);
  assert.deepEqual(databaseUrlMatches, []);
  assert.deepEqual(cookieAssignmentMatches, []);
  assert.deepEqual(capturedCookieValueMatches, []);

  return {
    processSecretMatches,
    databaseUrlMatches,
    cookieAssignmentMatches,
    capturedCookieValueMatches,
  };
};

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

    if (code === 0) {
      resolve(options.capture ? output : undefined);
    } else {
      const captured = options.capture
        ? sanitizedCommandFailure(`${output.stdout}\n${output.stderr}`.trim())
        : "";

      reject(
        new Error(
          `${options.label} exited with ${signal ?? `code ${code}`}${captured.length === 0 ? "" : `\n${captured}`}`,
        ),
      );
    }
  });

  return promise;
};

const outputTailBytes = 16_384;

/** Starts a long-running process; its output stays in a bounded tail for readiness failures. */
const start = (command, args, env, cwd) => {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";

  const remember = (chunk) => {
    tail = `${tail}${chunk}`.slice(-outputTailBytes);
  };

  child.stdout.on("data", remember);
  child.stderr.on("data", remember);
  child.outputTail = () => sanitizedCommandFailure(tail.trim());

  return child;
};

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
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before readiness\n${child.outputTail()}`);
    }

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
  const sensitiveCookieValues = new Set();

  const server = createServer(async (request, response) => {
    const started = Date.now();
    const method = request.method ?? "GET";
    const target = new URL(request.url ?? "/", targetOrigin);
    const chunks = [];

    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBytes = Buffer.concat(chunks);
    rememberCookieHeader(sensitiveCookieValues, request.headers.cookie);

    const record = {
      direction: "dashboard-to-native-backend",
      destination: "loopback-recording-boundary-to-native-backend",
      method,
      path: target.pathname,
      authorityDataMatches: {
        path: findAuthorityData(`${target.pathname}${target.search}`),
        request: findAuthorityData(requestBytes.toString("utf8")),
        response: [],
      },
      legacyOrProvider: isLegacyOrProviderPath(target.pathname),
      status: 0,
      durationMs: 0,
      responseByteLength: 0,
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
        body: method === "GET" || method === "HEAD" ? undefined : requestBytes,
        redirect: "manual",
      });

      const bytes = Buffer.from(await upstream.arrayBuffer());
      const bodyText = bytes.toString("utf8");
      record.status = upstream.status;
      record.durationMs = Date.now() - started;
      record.responseByteLength = bytes.byteLength;
      record.authorityDataMatches.response = findAuthorityData(bodyText);
      response.statusCode = upstream.status;

      if (target.pathname === "/api/session") {
        if (upstream.status === 200) {
          const projection = Schema.decodeUnknownSync(SessionResponse, {
            onExcessProperty: "error",
          })(JSON.parse(bodyText));

          assert.equal(projection.current, true);
          assert.ok(Date.parse(projection.expiresAt) > Date.now());
          assert.equal(bodyText, JSON.stringify(JSON.parse(bodyText)));
          record.sessionProjection = {
            keys: Object.keys(projection),
            sessionId: projection.sessionId,
            expiresAt: projection.expiresAt,
            current: projection.current,
            bodyByteLength: bytes.byteLength,
            exactJsonBytes: true,
          };
        } else if (upstream.status === 401) {
          const problem = Schema.decodeUnknownSync(NativeProblem, { onExcessProperty: "error" })(
            JSON.parse(bodyText),
          );

          assert.ok(credentialProblemCodes.includes(problem.code), `unexpected ${problem.code}`);
          assert.equal(bodyText, JSON.stringify(JSON.parse(bodyText)));
          record.unauthenticatedProjection = {
            keys: ["code"],
            code: problem.code,
            bodyByteLength: bytes.byteLength,
            exactJsonBytes: true,
          };
        }
      }

      const retryAfter = upstream.headers.get("x-retry-after");

      if (retryAfter !== null && /^\d+$/u.test(retryAfter))
        record.retryAfterSeconds = Number(retryAfter);
      const setCookies = upstream.headers.getSetCookie();

      for (const setCookie of setCookies) rememberSetCookie(sensitiveCookieValues, setCookie);

      for (const [name, value] of upstream.headers.entries()) {
        if (["content-encoding", "content-length", "transfer-encoding"].includes(name)) continue;

        if (name === "set-cookie") {
          response.setHeader(name, setCookies);
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
  assert.ok(address && !Predicate.isString(address));

  return {
    origin: `http://127.0.0.1:${address.port}`,
    records,
    sensitiveCookieValues,
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
  const hardeningEvidencePath = join(temporaryRoot, "session-hardening-browser-evidence.json");
  let postgres;
  let backend;
  let dashboard;
  let boundary;
  let evidence;
  let failure;

  try {
    await run(
      postgresProgram("initdb"),
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
      postgresProgram("pg_ctl"),
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
              postgresProgram("psql"),
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
      postgresProgram("createdb"),
      ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres", postgresDatabase],
      { cwd: repositoryRoot, env: baseEnvironment, label: "Identity database creation" },
    );

    const seed = await run("node", ["apps/dashboard/e2e/native-identity-browser-seed.mjs"], {
      cwd: repositoryRoot,
      env: {
        ...baseEnvironment,
        IDENTITY_EVIDENCE_PG_URL: postgresUrl,
        IDENTITY_EVIDENCE_PASSWORD: password,
        BETTER_AUTH_SECRET: secret,
        NATIVE_IDENTITY_DEPLOYMENT: "local",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
      },
      capture: true,
      label: "Identity 0065 seed",
    });

    const seedEvidence = JSON.parse(seed.stdout.trim());
    assert.equal(seedEvidence.personId, "journey-0065-admin");
    assert.deepEqual(seedEvidence.member, {
      personId: "journey-0073-member",
      emailClass: "synthetic.invalid",
      displayName: "Mina Member",
      organizationAuthorities: 0,
    });
    assert.deepEqual(seedEvidence.migrations, [
      { revision: 15, name: "native-identity-better-auth" },
      { revision: 23, name: "declarative-authorization-rules" },
      { revision: 24, name: "identity-security-audit" },
    ]);
    assert.deepEqual(
      seedEvidence.authSchema.beforePublicAuthz,
      seedEvidence.authSchema.afterPublicAuthz,
    );
    assert.equal(seedEvidence.publicAuthz.tags.length, 1);
    assert.equal(seedEvidence.publicAuthz.assignments.length, 1);
    assert.equal(seedEvidence.publicAuthz.rules.length, 2);
    backend = start(
      "bun",
      ["run", "--cwd", "apps/backend", "start"],
      {
        ...baseEnvironment,
        ...localBackendEnvironment({
          backendOrigin,
          dashboardOrigin,
          postgresUrl,
          betterAuthSecret: secret,
        }),
        NODE_ENV: "production",
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
        DASHBOARD_MOUNT: "/",
      },
      label: "Identity dashboard production build",
    });

    const dashboardEnvironment = {
      ...baseEnvironment,
      API_URL: boundary.origin,
      VITE_API_URL: boundary.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      DASHBOARD_MOUNT: "/",
      REAL_NATIVE_IDENTITY_E2E: "1",
      IDENTITY_EVIDENCE_EMAIL: "admin.identity-0065@example.invalid",
      IDENTITY_EVIDENCE_PASSWORD: password,
      IDENTITY_EVIDENCE_WRONG_PASSWORD: wrongPassword,
      IDENTITY_EVIDENCE_BROWSER_PATH: browserEvidencePath,
      IDENTITY_EVIDENCE_MEMBER_EMAIL: memberEmail,
      IDENTITY_EVIDENCE_MEMBER_PASSWORD: password,
      IDENTITY_EVIDENCE_ADMIN_SCREENSHOT_PATH: adminScreenshotPath,
      IDENTITY_EVIDENCE_MEMBER_SCREENSHOT_PATH: memberScreenshotPath,
      IDENTITY_HARDENING_BROWSER_PATH: hardeningEvidencePath,
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
    const hardeningEvidence = JSON.parse(await readFile(hardeningEvidencePath, "utf8"));
    assert.equal(hardeningEvidence.specId, "0054.1");
    assert.equal(hardeningEvidence.passed, true);
    assert.deepEqual(hardeningEvidence.sessionProjection.fields, sessionFields);
    assert.deepEqual(hardeningEvidence.sessionProjection.credentialFieldsObserved, []);
    assert.equal(hardeningEvidence.sessionProjection.oneCurrent, 1);
    assert.deepEqual(hardeningEvidence.revocation.revokeOthers, [204, 204]);
    assert.deepEqual(hardeningEvidence.revocation.repeatedAndMissing, [404, 404]);
    assert.deepEqual(hardeningEvidence.revocation.immediateReplay, [401, 401, 401, 401]);
    assert.deepEqual(hardeningEvidence.ownership, {
      memberAgainstAdministrator: 404,
      administratorAgainstMember: 404,
      responseEqual: true,
    });
    assert.deepEqual(hardeningEvidence.signup, { status: 400, sessionCreated: false });
    assert.equal(hardeningEvidence.cookieValueRecorded, false);
    assert.equal(browserEvidence.passed, true);
    assert.equal(browserEvidence.extensionSpecId, "0056");
    assert.deepEqual(browserEvidence.accessibilityViolations, {
      initial: 0,
      memberShell: 0,
      invalid: 0,
      rateLimit: 0,
    });
    assert.deepEqual(findAuthorityData(JSON.stringify(browserEvidence)), []);
    assert.equal(browserEvidence.authorityIsolation.browserArtifacts.length, 7);
    assert.ok(
      browserEvidence.authorityIsolation.browserArtifacts.every(
        (artifact) =>
          artifact.domMatches.length === 0 &&
          artifact.htmlMatches.length === 0 &&
          artifact.localStorageMatches.length === 0 &&
          artifact.sessionStorageMatches.length === 0 &&
          artifact.cookieNameMatches.length === 0 &&
          artifact.cookieValueMatches.length === 0,
      ),
    );
    assert.deepEqual(browserEvidence.screenshots, {
      admin: adminScreenshotPath,
      member: memberScreenshotPath,
      syntheticPersonasOnly: true,
    });

    for (const screenshotPath of [adminScreenshotPath, memberScreenshotPath]) {
      const screenshot = await readFile(screenshotPath);
      assert.deepEqual(
        [...screenshot.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
        `${screenshotPath} must be a PNG`,
      );
    }

    assert.deepEqual(browserEvidence.requestLedger.forbidden, []);
    assert.deepEqual(browserEvidence.requestLedger.unexpectedDestinations, []);
    assert.ok(
      boundary.records.some((entry) => entry.path === "/api/profile" && entry.status === 403),
      "no-scope member profile denial must reach the native backend",
    );
    assert.ok(
      boundary.records.some(
        (entry) => entry.path === "/api/auth/get-session" && entry.status === 200,
      ),
      "member shell must recover identity from Better Auth session",
    );

    const nativeSignIn = boundary.records.filter(
      (entry) => entry.path === "/api/auth/sign-in/email",
    );

    assert.equal(nativeSignIn.length, 17);
    assert.equal(
      nativeSignIn.filter(({ status }) => status === 200).length,
      7,
      "hardening and dashboard personas must sign in through Better Auth",
    );
    assert.equal(nativeSignIn[0].status, 200);
    const wrongStatuses = nativeSignIn.slice(-10).map((entry) => entry.status);
    assert.deepEqual(wrongStatuses, [401, 401, 401, 429, 429, 429, 429, 429, 429, 429]);

    const nativeSignOut = boundary.records.filter(
      (entry) => entry.path === "/api/session" && entry.method === "DELETE",
    );

    const explicitSignOut = nativeSignOut.filter(({ status }) => status === 204);
    const revokedReplaySignOut = nativeSignOut.filter(({ status }) => status === 401);
    assert.ok(
      explicitSignOut.length >= 4,
      "hardening and dashboard journeys must persist every first sign-out",
    );
    assert.ok(
      revokedReplaySignOut.length >= 3,
      "revoked-cookie sign-out retries must fail before another mutation",
    );

    const sessionRequests = boundary.records.filter(
      (entry) => entry.path === "/api/session" && entry.method === "GET",
    );

    assert.ok(sessionRequests.some((entry) => entry.status === 200));
    assert.ok(sessionRequests.some((entry) => entry.status === 401));

    const successfulSessionProjections = sessionRequests
      .filter((entry) => entry.status === 200)
      .map((entry) => entry.sessionProjection);

    const unauthenticatedSessionProjections = sessionRequests
      .filter((entry) => entry.status === 401)
      .map((entry) => entry.unauthenticatedProjection);

    assert.ok(
      successfulSessionProjections.every(
        (projection) =>
          projection !== undefined &&
          projection.exactJsonBytes === true &&
          projection.current === true &&
          Predicate.isString(projection.sessionId) &&
          projection.sessionId.length > 0 &&
          [...projection.keys].sort().join(",") === sessionFields.join(","),
      ),
      "successful session projections must be exact credential-free metadata",
    );
    assert.ok(
      unauthenticatedSessionProjections.every(
        (projection) =>
          projection !== undefined &&
          projection.exactJsonBytes === true &&
          credentialProblemCodes.includes(projection.code),
      ),
    );
    const forbidden = boundary.records.filter((entry) => entry.legacyOrProvider);

    const apiAuthorityRequests = boundary.records.filter((entry) =>
      Object.values(entry.authorityDataMatches).some((matches) => matches.length > 0),
    );

    assert.deepEqual(forbidden, []);
    assert.deepEqual(apiAuthorityRequests, []);

    const proofOutput = await run(
      "bun",
      ["run", "--cwd", "packages/database", "proof:identity-browser"],
      {
        cwd: repositoryRoot,
        env: {
          ...baseEnvironment,
          IDENTITY_EVIDENCE_PG_URL: postgresUrl,
          IDENTITY_EVIDENCE_AUTH_SCHEMA_BASELINE: JSON.stringify(
            seedEvidence.authSchema.afterPublicAuthz,
          ),
          IDENTITY_EVIDENCE_PUBLIC_AUTHZ_BASELINE: JSON.stringify(seedEvidence.publicAuthz),
        },
        capture: true,
        label: "Identity 0056 PostgreSQL orthogonality proof",
      },
    );

    const postgresEvidence = JSON.parse(proofOutput.stdout.trim());
    assert.equal(postgresEvidence.extensionSpecId, "0056");
    assert.deepEqual(postgresEvidence.authSchemaState, seedEvidence.authSchema.afterPublicAuthz);
    assert.deepEqual(postgresEvidence.publicAuthz, seedEvidence.publicAuthz);
    assert.deepEqual(postgresEvidence.identitySecurityAudit.counts, {
      "account-provisioned-administratively": 2,
      "session-revoked-all": 1,
      "session-revoked-one": 1,
      "session-revoked-others": 1,
      "sign-in-failure": 10,
      "sign-in-success": 7,
      "sign-out": 4,
      "sign-up-rejected": 1,
      "trusted-origin-csrf-rejected": 1,
    });
    assert.equal(postgresEvidence.identitySecurityAudit.rowsBoundedAndLinked, true);
    assert.equal(postgresEvidence.identitySecurityAudit.appendOnlyUpdateRejected, true);
    assert.equal(postgresEvidence.identitySecurityAudit.appendOnlyDeleteRejected, true);
    assert.equal(
      postgresEvidence.identitySecurityAudit.ordering.atomicCredentialAuditClaimed,
      false,
    );
    assert.deepEqual(
      {
        activeAssignments: postgresEvidence.authzActivity.activeAssignments,
        activeRules: postgresEvidence.authzActivity.activeRules,
        expiredRules: postgresEvidence.authzActivity.expiredRules,
        activeOtherPersonRules: postgresEvidence.authzActivity.activeOtherPersonRules,
        expiredJourneyPersonRules: postgresEvidence.authzActivity.expiredJourneyPersonRules,
      },
      {
        activeAssignments: 1,
        activeRules: 1,
        expiredRules: 1,
        activeOtherPersonRules: 1,
        expiredJourneyPersonRules: 1,
      },
    );

    // The journey's backend stored Better Auth keys encrypted with the journey secret, and the
    // focused test uses its own secret, so it proves the adapter on a database of its own.
    const authLiveDatabase = "identity_auth_live_proof_0065";

    await run(
      postgresProgram("createdb"),
      ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres", authLiveDatabase],
      { cwd: repositoryRoot, env: baseEnvironment, label: "Identity adapter proof database" },
    );
    await run("bunx", ["vitest", "run", "src/auth-live.test.ts"], {
      cwd: join(repositoryRoot, "packages/database"),
      env: {
        ...baseEnvironment,
        AUTH_TEST_PG_URL: `postgres://postgres@127.0.0.1:${postgresPort}/${authLiveDatabase}`,
      },
      capture: true,
      label: "Identity adapter audit rollback proof",
    });

    const identityBehavior = {
      login: {
        nativeStatus: nativeSignIn[0].status,
        redirect: browserEvidence.observations.login.redirect,
        cookieName: browserEvidence.observations.login.cookieName,
        cookieValueRecorded: browserEvidence.observations.login.cookieValueRecorded,
        cookieAttributes: browserEvidence.observations.login.cookieAttributes,
      },
      sessionProjection: {
        statuses: sessionRequests.map(({ status }) => status),
        successful: successfulSessionProjections,
        unauthenticated: unauthenticatedSessionProjections,
      },
      reload: browserEvidence.observations.reload,
      logout: {
        nativeStatuses: explicitSignOut.map(({ status }) => status),
        browser: browserEvidence.observations.logout,
      },
      revokedCookieReplay: {
        ...browserEvidence.observations.oldCookieReplay,
        cleanupSignOutStatuses: revokedReplaySignOut.map(({ status }) => status),
      },
      rateLimit: {
        nativeStatuses: wrongStatuses,
        browser: browserEvidence.observations.wrongPassword,
      },
      accessibility: {
        violations: browserEvidence.accessibilityViolations,
        semantics: browserEvidence.observations.accessibility,
      },
    };

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
      run(postgresProgram("psql"), ["--version"], {
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
      extensionSpecId: "0056",
      amendmentSpecId: "0054.1",
      baseCommit: "2bcc38a605c9c85dcc1be722dff361138c801827",
      extensionSourceCommit: "4cc5cea669fa30d4fd8782f411eb9dcf86ba1380",
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
      identityBehavior,
      sessionHardening: hardeningEvidence,
      native: {
        signInStatuses: nativeSignIn.map(({ status }) => status),
        wrongPasswordStatuses: wrongStatuses,
        signOutStatuses: nativeSignOut.map(({ status }) => status),
        explicitSignOutStatuses: explicitSignOut.map(({ status }) => status),
        revokedReplayCleanupSignOutStatuses: revokedReplaySignOut.map(({ status }) => status),
        sessionStatuses: sessionRequests.map(({ status }) => status),
      },
      postgres: {
        ...postgresEvidence,
        adapterAuditRollbackProof: {
          test: "AuthLive focused PostgreSQL transaction failure",
          passed: true,
        },
        comparisons: {
          authSchema: {
            beforePublicAuthzSeed: seedEvidence.authSchema.beforePublicAuthz,
            beforeBrowser: seedEvidence.authSchema.afterPublicAuthz,
            afterBrowser: postgresEvidence.authSchemaState,
          },
          publicAuthz: {
            beforeBrowser: seedEvidence.publicAuthz,
            afterBrowser: postgresEvidence.publicAuthz,
          },
        },
      },
      recorder: {
        legacyOrProviderRequests: forbidden,
        browserLegacyOrProviderRequests: browserEvidence.requestLedger.forbidden,
        unexpectedBrowserDestinations: browserEvidence.requestLedger.unexpectedDestinations,
        apiRequestsWithAuthorityData: apiAuthorityRequests,
        browserRequestsWithAuthorityData:
          browserEvidence.authorityIsolation.requestsWithAuthorityData,
        rawRequestHeaders: 0,
        rawResponseHeaders: 0,
        rawRequestBodies: 0,
        rawResponseBodies: 0,
        queryStrings: 0,
      },
      requestLedger: ledger,
      cleanup: { pending: true },
      passed: true,
    };
  } catch (error) {
    failure = error;

    for (const [label, child] of [
      ["backend", backend],
      ["dashboard", dashboard],
    ]) {
      if (child !== undefined) process.stderr.write(`${label} output tail:\n${child.outputTail()}\n`);
    }

    const boundaryTail = (boundary?.records ?? [])
      .slice(-40)
      .map(({ method, path, status }) => `${method} ${path} ${status}`);

    process.stderr.write(`dashboard-to-backend requests:\n${boundaryTail.join("\n")}\n`);
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
      await run(postgresProgram("pg_ctl"), ["-D", postgresRoot, "-m", "fast", "-w", "stop"], {
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
  evidence.sanitization = sanitizationFacts(evidence, boundary?.sensitiveCookieValues ?? new Set());
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`Real native Identity runner failed: ${detail(error)}\n`);
  process.exitCode = 1;
});
