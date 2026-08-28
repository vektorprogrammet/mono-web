import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitRuntimeEvidenceReceipts,
  sanitizePlaywrightArtifact,
} from "./runtime-evidence-receipt.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const postgresPort = 55446;
const backendPort = 8800;
const dashboardPort = 5194;
const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/postgres`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const fixedClock = "2026-09-15T12:00:00.000Z";
const applicationId = "application-native-journey-0049";
const leaderPersonId = "journey-rec-leader-0049";
const interviewerPersonId = "journey-rec-interviewer-a-0049";
const interviewSchemaId = "interview-schema-native-journey-0049";
const betterAuthSecret = randomBytes(32).toString("base64url");
const commandTimeoutMs = 300_000;
const shutdownTimeoutMs = 5_000;
const runnerPath = fileURLToPath(import.meta.url);
const specPath = join(dashboardRoot, "e2e/native-recruitment-session-journey.spec.ts");
const seedPath = join(dashboardRoot, "e2e/native-recruitment-journey-seed.mjs");

const journeyEntries = [
  {
    journeyRefId: "intent://journey:recruitment:applicant-assignment:v1",
    stepIds: [
      "mono-session-login",
      "load-applicant-list",
      "load-interviewer-options",
      "load-interview-schema-options",
      "assign-interview",
      "fresh-read-applicant-list",
    ],
  },
  {
    journeyRefId: "intent://journey:recruitment:review-applicants:v1",
    stepIds: ["mono-session-login", "list-current-applicants"],
  },
];

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const errorDetail = (error) =>
  error instanceof AggregateError
    ? `${error.message}: ${error.errors.map(errorDetail).join("; ")}`
    : error instanceof Error
      ? error.message
      : String(error);

const assertEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`,
    );
  }
};

const assertPortAvailable = (port) =>
  new Promise((resolveAvailable, rejectAvailable) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      rejectAvailable(new Error(`loopback port ${port} is already in use`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error?.code === "ECONNREFUSED") resolveAvailable();
      else
        rejectAvailable(
          new Error(`could not inspect loopback port ${port}: ${errorDetail(error)}`),
        );
    });
  });

const waitForPortRelease = async (port) => {
  const deadline = Date.now() + shutdownTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await assertPortAvailable(port);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`loopback port ${port} was not released`);
};

const run = (command, args, options) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      detached: true,
    });
    const stdout = [];
    const stderr = [];
    if (options.capture) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      if (!settled) {
        settled = true;
        rejectRun(new Error(`${options.label} timed out`));
      }
    }, commandTimeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(new Error(`${options.label} could not start: ${errorDetail(error)}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolveRun(options.capture ? output : undefined);
      else {
        const detail = [output.stdout.trim(), output.stderr.trim()].filter(Boolean).join("\n");
        rejectRun(
          new Error(
            `${options.label} exited with ${signal ?? `code ${code}`}${detail ? `:\n${detail}` : ""}`,
          ),
        );
      }
    });
  });

const start = (command, args, environment, cwd) => {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  child.once("error", () => undefined);
  return child;
};

const stop = async (child) => {
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  ) {
    return;
  }
  process.kill(-child.pid, "SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    sleep(shutdownTimeoutMs),
  ]);
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
};

const waitForHttp = async (url, child, label) => {
  const deadline = Date.now() + commandTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before readiness`);
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await sleep(250);
  }
  throw new Error(`${label} did not become ready`);
};

const runPsql = async (sql, environment, label) => {
  const output = await run(
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
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { cwd: repositoryRoot, env: environment, capture: true, label },
  );
  return output.stdout.trim();
};

const parseJsonBody = (bytes) => {
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
};

const sessionCookieNames = new Set([
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
]);
const hasNamedCookie = (cookieHeader, names) =>
  typeof cookieHeader === "string" &&
  cookieHeader.split(";").some((pair) => {
    const separator = pair.indexOf("=");
    return separator > 0 && names.has(pair.slice(0, separator).trim());
  });

const startRecordingProxy = async (targetOrigin) => {
  const records = [];
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", targetOrigin);
    const path = requestUrl.pathname;
    const pathAndQuery = `${path}${requestUrl.search}`;
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBytes = Buffer.concat(chunks);
    const record = {
      method,
      path,
      pathAndQuery,
      status: 0,
      sessionCookieAuth: hasNamedCookie(request.headers.cookie, sessionCookieNames),
      jwtCookieAuth: hasNamedCookie(request.headers.cookie, new Set(["jwt_token"])),
      authorizationHeaderPresent: request.headers.authorization !== undefined,
      requestJsonDecoded: parseJsonBody(requestBytes) !== undefined,
    };
    records.push(record);

    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value === undefined ||
          ["connection", "content-length", "host", "transfer-encoding"].includes(name)
        ) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, value);
        }
      }
      const upstream = await fetch(requestUrl, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : requestBytes,
        redirect: "manual",
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      record.status = upstream.status;
      if (upstream.status >= 400) record.responseFailure = parseJsonBody(responseBytes);
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers.entries()) {
        if (
          ["content-encoding", "content-length", "set-cookie", "transfer-encoding"].includes(name)
        ) {
          continue;
        }
        response.setHeader(name, value);
      }
      const setCookie = upstream.headers.getSetCookie();
      if (setCookie.length > 0) response.setHeader("set-cookie", setCookie);
      response.setHeader("content-length", String(responseBytes.byteLength));
      response.end(responseBytes);
    } catch (error) {
      record.status = 502;
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "native recruitment evidence proxy failed" }));
      process.stderr.write(`Native recruitment proxy failure: ${errorDetail(error)}\n`);
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("native recruitment evidence proxy did not bind a loopback port");
  }
  let closed = false;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    records,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) =>
          error === undefined || error?.code === "ERR_SERVER_NOT_RUNNING"
            ? resolveClose()
            : rejectClose(error),
        );
      });
    },
  };
};

const pathExists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const readJsonFile = async (path, label) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${errorDetail(error)}`);
  }
};

const readMigrationEvidence = async (environment) =>
  JSON.parse(
    await runPsql(
      `SELECT json_build_object(
        'count', (SELECT count(*)::int FROM vektorprogrammet_schema_migrations),
        'minimumId', (SELECT min(migration_id)::int FROM vektorprogrammet_schema_migrations),
        'maximumId', (SELECT max(migration_id)::int FROM vektorprogrammet_schema_migrations),
        'contiguous', NOT EXISTS (
          SELECT 1 FROM generate_series(1, (SELECT max(migration_id) FROM vektorprogrammet_schema_migrations)) AS expected(id)
          LEFT JOIN vektorprogrammet_schema_migrations actual ON actual.migration_id = expected.id
          WHERE actual.migration_id IS NULL
        ),
        'recruitmentAssignment', (SELECT json_build_object('id', migration_id, 'name', name) FROM vektorprogrammet_schema_migrations WHERE migration_id = 10),
        'head', (SELECT json_build_object('id', migration_id, 'name', name) FROM vektorprogrammet_schema_migrations ORDER BY migration_id DESC LIMIT 1)
      )`,
      environment,
      "canonical migration evidence",
    ),
  );

const readPersistenceEvidence = async (environment) =>
  JSON.parse(
    await runPsql(
      `SELECT json_build_object(
        'interviewCount', (SELECT count(*)::int FROM recruitment_interviews WHERE application_id = '${applicationId}'),
        'scheduleCount', (SELECT count(*)::int FROM recruitment_interview_schedules schedule INNER JOIN recruitment_interviews interview ON interview.interview_id = schedule.interview_id WHERE interview.application_id = '${applicationId}'),
        'receiptCount', (SELECT count(*)::int FROM recruitment_assignment_command_receipts WHERE application_id = '${applicationId}'),
        'auditCount', (SELECT count(*)::int FROM recruitment_assignment_audit WHERE application_id = '${applicationId}'),
        'interview', (SELECT row_to_json(value) FROM (
          SELECT interview_id AS "interviewId", application_id AS "applicationId", department_id AS "departmentId",
            interviewer_person_id AS "interviewerPersonId", interview_schema_id AS "interviewSchemaId",
            assigned_by_person_id AS "assignedByPersonId", to_char(assigned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "assignedAt",
            revision
          FROM recruitment_interviews WHERE application_id = '${applicationId}'
        ) value),
        'receipt', (SELECT row_to_json(value) FROM (
          SELECT command_id AS "commandId", application_id AS "applicationId", interview_id AS "interviewId",
            command_json->>'applicationId' AS "commandApplicationId",
            command_json->>'interviewerPersonId' AS "commandInterviewerPersonId",
            command_json->>'interviewSchemaId' AS "commandInterviewSchemaId",
            to_char(committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "committedAt"
          FROM recruitment_assignment_command_receipts WHERE application_id = '${applicationId}'
        ) value),
        'audit', (SELECT row_to_json(value) FROM (
          SELECT command_id AS "commandId", interview_id AS "interviewId", application_id AS "applicationId",
            department_id AS "departmentId", actor_person_id AS "actorPersonId", action,
            interview_revision AS "interviewRevision",
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
          FROM recruitment_assignment_audit WHERE application_id = '${applicationId}'
        ) value)
      )`,
      environment,
      "native recruitment persistence evidence",
    ),
  );

const assertMigrationEvidence = (evidence) => {
  if (
    evidence.count !== 22 ||
    evidence.minimumId !== 1 ||
    evidence.maximumId !== 22 ||
    evidence.contiguous !== true ||
    evidence.recruitmentAssignment?.id !== 10 ||
    evidence.recruitmentAssignment?.name !== "native-recruitment-applicant-assignment" ||
    evidence.head?.id !== 22 ||
    evidence.head?.name !== "native-domain-schema-boundary"
  ) {
    throw new Error(`canonical migration evidence failed: ${JSON.stringify(evidence)}`);
  }
};

const assertPersistenceEvidence = (evidence) => {
  const { interview, receipt, audit } = evidence;
  if (
    evidence.interviewCount !== 1 ||
    evidence.scheduleCount !== 0 ||
    evidence.receiptCount !== 1 ||
    evidence.auditCount !== 1 ||
    interview?.applicationId !== applicationId ||
    interview?.interviewerPersonId !== interviewerPersonId ||
    interview?.interviewSchemaId !== interviewSchemaId ||
    interview?.assignedByPersonId !== leaderPersonId ||
    interview?.assignedAt !== fixedClock ||
    interview?.revision !== 0 ||
    receipt?.applicationId !== applicationId ||
    receipt?.interviewId !== interview?.interviewId ||
    receipt?.commandApplicationId !== applicationId ||
    receipt?.commandInterviewerPersonId !== interviewerPersonId ||
    receipt?.commandInterviewSchemaId !== interviewSchemaId ||
    receipt?.committedAt !== fixedClock ||
    audit?.commandId !== receipt?.commandId ||
    audit?.interviewId !== interview?.interviewId ||
    audit?.applicationId !== applicationId ||
    audit?.departmentId !== interview?.departmentId ||
    audit?.actorPersonId !== leaderPersonId ||
    audit?.actorPersonId !== interview?.assignedByPersonId ||
    audit?.action !== "ApplicantAssigned" ||
    audit?.interviewRevision !== 0 ||
    audit?.occurredAt !== fixedClock
  ) {
    throw new Error(`native recruitment persistence evidence failed: ${JSON.stringify(evidence)}`);
  }
};

const receiptRequested = () =>
  [
    "RUNTIME_EVIDENCE_RECEIPT_PATH",
    "RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_MONO_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS",
  ].some((name) => typeof process.env[name] === "string" && process.env[name].length > 0);

const emitReceipts = async (playwrightOutput) => {
  if (!receiptRequested()) return;
  const sourceRefIds = (process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const sourcePaths = [runnerPath, specPath];
  if (sourceRefIds.length === 0 || sourceRefIds.length > sourcePaths.length) {
    throw new Error("native recruitment evidence expects one or two runner source references");
  }
  const runnerSourceInputBytes = await Promise.all(
    sourceRefIds.map(async (sourceRefId, index) => ({
      sourceRefId,
      bytes: await readFile(sourcePaths[index]),
    })),
  );
  const fixtureInputBytes = await readFile(seedPath);
  const artifactBytes = sanitizePlaywrightArtifact(Buffer.from(playwrightOutput, "utf8"));
  const forbiddenArtifactValues = [
    betterAuthSecret,
    "journey-secret-0123456789abcdef",
    "jwt_token=",
    "better-auth.session_token=",
  ];
  if (forbiddenArtifactValues.some((value) => artifactBytes.includes(Buffer.from(value)))) {
    throw new Error("sanitized Playwright artifact exposed raw authentication material");
  }
  await emitRuntimeEvidenceReceipts({
    journeys: journeyEntries,
    fixtureId: "native-recruitment-applicant-assignment-0049-1",
    runnerSourceInputBytes,
    fixtureInputBytes,
    artifactBytes,
  });
};

const main = async () => {
  await Promise.all([
    assertPortAvailable(postgresPort),
    assertPortAvailable(backendPort),
    assertPortAvailable(dashboardPort),
  ]);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-native-recruitment-0049-1-"));
  const postgresRoot = join(temporaryRoot, "postgres");
  const browserEvidencePath = join(temporaryRoot, "browser-evidence.json");
  const baseEnvironment = { ...process.env };
  for (const name of [
    "API_MODE",
    "VITE_API_MODE",
    "ALCHEMY_CLOUDFLARE_VITE_INJECTED",
    "ADMISSION_AUTH_TOKENS",
    "ORGANIZATION_AUTH_TOKENS",
    "RECEIPT_AUTH_TOKENS",
    "JWT_SECRET",
    "SYMFONY_API_URL",
  ]) {
    delete baseEnvironment[name];
  }
  const processEnvironment = {
    ...baseEnvironment,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: betterAuthSecret,
    BETTER_AUTH_URL: dashboardOrigin,
    ADMISSION_FIXED_NOW: fixedClock,
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  };

  let postgresStarted = false;
  let backend;
  let dashboard;
  let proxy;
  let evidence;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const errors = [];
    try {
      await stop(dashboard);
    } catch (error) {
      errors.push(error);
    }
    try {
      await proxy?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await stop(backend);
    } catch (error) {
      errors.push(error);
    }
    if (postgresStarted) {
      try {
        if (await pathExists(join(postgresRoot, "postmaster.pid"))) {
          await run("pg_ctl", ["-D", postgresRoot, "-m", "fast", "-w", "stop"], {
            cwd: repositoryRoot,
            env: baseEnvironment,
            label: "native recruitment PostgreSQL cleanup",
          });
        }
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "native recruitment cleanup failed");
  };

  const handleSignal = (signal) => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const handleInterrupt = () => handleSignal("SIGINT");
  const handleTermination = () => handleSignal("SIGTERM");
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);

  let primaryError;
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
        label: "native recruitment PostgreSQL initialization",
      },
    );
    postgresStarted = true;
    await run(
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
      { cwd: repositoryRoot, env: baseEnvironment, label: "native recruitment PostgreSQL startup" },
    );
    await runPsql("SELECT 1", baseEnvironment, "native recruitment PostgreSQL readiness");

    await run("bun", [seedPath], {
      cwd: repositoryRoot,
      env: {
        ...processEnvironment,
        JOURNEY_SEED_PG_URL: postgresUrl,
      },
      label: "existing native recruitment fixture and Identity seed",
    });
    const migrations = await readMigrationEvidence(baseEnvironment);
    assertMigrationEvidence(migrations);

    backend = start(
      "bun",
      ["run", "--cwd", "apps/backend", "start"],
      processEnvironment,
      repositoryRoot,
    );
    await waitForHttp(`${backendOrigin}/health`, backend, "unified native backend");
    proxy = await startRecordingProxy(backendOrigin);

    const journeyEnvironment = {
      ...processEnvironment,
      API_URL: proxy.origin,
      VITE_API_URL: proxy.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      REAL_NATIVE_IDENTITY_E2E: "1",
      REAL_NATIVE_CONDUCT_E2E: "1",
      RECRUITMENT_E2E_BROWSER_EVIDENCE_PATH: browserEvidencePath,
      RECRUITMENT_E2E_LEADER_PERSON_ID: leaderPersonId,
    };
    await run("bun", ["run", "build"], {
      cwd: sdkRoot,
      env: journeyEnvironment,
      label: "native recruitment SDK build",
    });
    dashboard = start(
      process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
      [
        "node_modules/@react-router/dev/dist/cli/index.js",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(dashboardPort),
      ],
      journeyEnvironment,
      dashboardRoot,
    );
    await waitForHttp(`${dashboardOrigin}/login`, dashboard, "native dashboard");

    const playwrightArgs = [
      "./node_modules/@playwright/test/cli.js",
      "test",
      "e2e/native-recruitment-session-journey.spec.ts",
      "--project=chromium",
      "--workers=1",
      "--retries=0",
    ];
    if (receiptRequested()) playwrightArgs.push("--reporter=json");
    const playwright = await run(process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node", playwrightArgs, {
      cwd: dashboardRoot,
      env: journeyEnvironment,
      capture: true,
      label: "real native recruitment Chromium journey",
    });

    const browser = await readJsonFile(browserEvidencePath, "native recruitment browser evidence");
    const expectedBridge = [
      { operation: "readAssignmentBoard", status: 200, authorizationHeaderPresent: false },
      { operation: "assignApplicant", status: 200, authorizationHeaderPresent: false },
      { operation: "readAssignmentBoard", status: 200, authorizationHeaderPresent: false },
      { operation: "readAssignmentBoard", status: 200, authorizationHeaderPresent: false },
    ];
    assertEqual(browser.bridgeResponses, expectedBridge, "browser bridge sequence");
    assertEqual(browser.journeys, journeyEntries, "browser receipt-support journey entries");
    if (
      browser.renderedNativeLogin !== true ||
      browser.sessionCookieName !== "better-auth.session_token" ||
      browser.sessionPersonId !== leaderPersonId ||
      browser.rawAuthenticationLeak !== false ||
      browser.accessibilityViolations !== 0 ||
      !Array.isArray(browser.pageErrors) ||
      browser.pageErrors.length !== 0 ||
      !Array.isArray(browser.legacyBrowserRequests) ||
      browser.legacyBrowserRequests.length !== 0 ||
      !Array.isArray(browser.externalBrowserRequests) ||
      browser.externalBrowserRequests.length !== 0
    ) {
      throw new Error(`browser evidence failed: ${JSON.stringify(browser)}`);
    }

    const recruitmentRequests = proxy.records.filter(({ path }) =>
      path.startsWith("/api/admin/recruitment/"),
    );
    const requiredTransportTail = [
      ["GET", "/api/admin/recruitment/assignment-board?status=new"],
      ["POST", "/api/admin/recruitment/interviews/assign"],
      ["GET", "/api/admin/recruitment/assignment-board?status=new"],
      ["GET", "/api/admin/recruitment/assignment-board?status=all"],
    ];
    const leadingInitialAllFilterReadCount =
      recruitmentRequests.length - requiredTransportTail.length;
    if (leadingInitialAllFilterReadCount !== 1 && leadingInitialAllFilterReadCount !== 2) {
      throw new Error("native recruitment transport had an unexpected request count");
    }
    const duplicateInitialAllFilterReadObserved = leadingInitialAllFilterReadCount === 2;
    const expectedTransport = [
      ...Array.from({ length: leadingInitialAllFilterReadCount }, () => [
        "GET",
        "/api/admin/recruitment/assignment-board?status=all",
      ]),
      ...requiredTransportTail,
    ].map(([method, pathAndQuery]) => ({
      method,
      pathAndQuery,
      status: 200,
      sessionCookieAuth: true,
      authorizationHeaderPresent: false,
      jwtCookieAuth: false,
    }));
    assertEqual(
      recruitmentRequests.map(
        ({
          method,
          pathAndQuery,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          jwtCookieAuth,
        }) => ({
          method,
          pathAndQuery,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          jwtCookieAuth,
        }),
      ),
      expectedTransport,
      "exact native recruitment transport",
    );
    const browserEvidence = {
      ...browser,
      duplicateInitialAllFilterReadObserved,
    };
    await writeFile(browserEvidencePath, `${JSON.stringify(browserEvidence)}\n`, "utf8");

    const legacyPaths = proxy.records.filter(({ path }) =>
      [
        "/api/admin/applications",
        "/api/admin/users",
        "/api/admin/interviews/schemas",
        "/api/admin/interviews/assign",
      ].some((legacyPath) => path === legacyPath || path.startsWith(`${legacyPath}/`)),
    );
    if (
      proxy.records.some(
        ({ authorizationHeaderPresent, jwtCookieAuth }) =>
          authorizationHeaderPresent || jwtCookieAuth,
      ) ||
      legacyPaths.length > 0
    ) {
      throw new Error(
        `legacy or bearer authentication transport observed: ${JSON.stringify({ legacyPaths })}`,
      );
    }

    const persisted = await readPersistenceEvidence(baseEnvironment);
    assertPersistenceEvidence(persisted);
    await emitReceipts(playwright.stdout);

    evidence = {
      topology: {
        database: "disposable-loopback-postgresql",
        migrations: "canonical-1-through-22",
        backend: "unified-native-effect-backend",
        dashboard: "loopback-react-router-dashboard",
        browser: "real-chromium",
        fixedClock,
        externalEffects: "disabled",
      },
      authentication: {
        renderedNativeLogin: true,
        cookieName: browser.sessionCookieName,
        personId: browser.sessionPersonId,
        processScopedBetterAuthConfiguration: true,
        bearerInjected: false,
        jwtCookieUsed: false,
        tokenMapConfigured: false,
        rawAuthenticationLeak: false,
      },
      browser: browserEvidence,
      nativeTransport: {
        initialAllFilterReadCount: leadingInitialAllFilterReadCount,
        duplicateInitialAllFilterReadObserved,
        requests: recruitmentRequests.map(
          ({ method, pathAndQuery, status, sessionCookieAuth, authorizationHeaderPresent }) => ({
            method,
            pathAndQuery,
            status,
            sessionCookieAuth,
            authorizationHeaderPresent,
          }),
        ),
      },
      postgres: { migrations, persisted },
      receiptSupport: {
        journeys: journeyEntries,
        finalReceiptsEmitted: receiptRequested(),
      },
    };
  } catch (error) {
    const postgresLog = await readFile(join(postgresRoot, "postgres.log"), "utf8").catch(
      () => "<postgres log unavailable>",
    );
    primaryError = new Error(
      `${errorDetail(error)}\nrecorded native transport: ${JSON.stringify(proxy?.records ?? [])}\nPostgreSQL log:\n${postgresLog}`,
      { cause: error },
    );
  }

  let cleanupError;
  try {
    await cleanup();
    if (await pathExists(temporaryRoot)) {
      throw new Error("native recruitment cleanup left the temporary root behind");
    }
    await Promise.all([
      waitForPortRelease(postgresPort),
      waitForPortRelease(backendPort),
      waitForPortRelease(dashboardPort),
    ]);
  } catch (error) {
    cleanupError = error;
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTermination);
  }

  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "native recruitment journey and cleanup failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;

  process.stdout.write(
    `${JSON.stringify({
      ...evidence,
      cleanup: {
        postgresRemoved: true,
        temporaryRootRemoved: true,
        portsReleased: [postgresPort, backendPort, dashboardPort],
      },
    })}\n`,
  );
};

main().catch((error) => {
  process.stderr.write(`Real native recruitment assignment runner failed: ${errorDetail(error)}\n`);
  process.exitCode = 1;
});
