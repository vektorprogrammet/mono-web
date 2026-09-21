import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  withProjectionFileLock,
  writeFilePathNoFollow,
} from "../../../packages/parity-inventory/node-runtime.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const postgresPort = 55445;
const backendPort = 8799;
const dashboardPort = 5174;
const postgresOrigin = `postgres://postgres@127.0.0.1:${postgresPort}/postgres`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const timeoutMs = 300_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const errorDetail = (error) => (error instanceof Error ? error.message : String(error));

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
      else reject(new Error(`could not inspect loopback port ${port}`));
    });
  });

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
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
        reject(new Error(`${options.label} timed out`));
      }
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${options.label} could not start: ${errorDetail(error)}`));
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
            `${options.label} exited with ${signal ?? `code ${code}`}${output.stderr ? `: ${output.stderr.trim()}` : ""}`,
          ),
        );
    });
  });

const start = (command, args, env, cwd) => {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  child.once("error", () => undefined);
  return child;
};
const stop = async (child) => {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) return;
  process.kill(-child.pid, "SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5_000)]);
  if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
};
const waitForHttp = async (url, child, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before readiness`);
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

const hasObjectKey = (value, key) => {
  if (Array.isArray(value)) return value.some((entry) => hasObjectKey(entry, key));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([entryKey, entryValue]) => entryKey === key || hasObjectKey(entryValue, key),
  );
};
const parseJson = (bytes) => {
  try {
    return bytes.length === 0 ? undefined : JSON.parse(bytes.toString());
  } catch {
    return undefined;
  }
};
const startProxy = async (targetOrigin) => {
  const records = [];
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", targetOrigin).pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBytes = Buffer.concat(chunks);
    const record = {
      method,
      path,
      status: 0,
      responseBody: undefined,
      requestHasCapability: hasObjectKey(parseJson(requestBytes), "responseCapability"),
      responseHasCapability: false,
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
      const upstream = await fetch(new URL(request.url ?? "/", targetOrigin), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : requestBytes,
        redirect: "manual",
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      if (upstream.status >= 400) record.responseBody = responseBytes.toString();
      record.status = upstream.status;
      response.statusCode = upstream.status;
      record.responseHasCapability = hasObjectKey(parseJson(responseBytes), "responseCapability");
      for (const [name, value] of upstream.headers.entries()) {
        if (["content-encoding", "content-length", "transfer-encoding"].includes(name)) continue;
        if (name === "set-cookie") {
          response.setHeader(name, upstream.headers.getSetCookie());
          continue;
        }
        response.setHeader(name, value);
      }
      response.setHeader("content-length", String(responseBytes.byteLength));
      response.end(responseBytes);
    } catch (error) {
      record.status = 502;
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ error: "conduct evidence proxy failed", detail: errorDetail(error) }),
      );
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
  if (address === null || typeof address === "string")
    throw new Error("conduct proxy did not bind a port");
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
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-native-conduct-0063-"));
  const postgresRoot = join(temporaryRoot, "postgres");
  const browserEvidencePath = join(temporaryRoot, "browser-evidence.json");
  const screenshotDirectory = join(temporaryRoot, "screenshots");
  const evidenceDirectory = join(repositoryRoot, "evidence", "functional-parity", "0108");
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;
  let postgres;
  let backend;
  let dashboard;
  let proxy;
  let primaryError;
  let screenshotEvidence;
  let runtimeEvidence;
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
      { cwd: repositoryRoot, env: baseEnvironment, label: "conduct PostgreSQL initialization" },
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
    const postgresDeadline = Date.now() + 30_000;
    while (Date.now() < postgresDeadline) {
      try {
        await runPsql("SELECT 1", baseEnvironment, "conduct PostgreSQL readiness");
        break;
      } catch {
        await sleep(250);
      }
    }
    if (Date.now() >= postgresDeadline) throw new Error("conduct PostgreSQL did not become ready");
    await run("bun", ["apps/dashboard/e2e/native-conduct-journey-seed.mjs"], {
      cwd: repositoryRoot,
      env: {
        ...baseEnvironment,
        JOURNEY_SEED_PG_URL: postgresOrigin,
        BETTER_AUTH_SECRET: "native-conduct-0063-disposable-secret-0123456789",
        NATIVE_IDENTITY_DEPLOYMENT: "local",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
      },
      label: "conduct fixture seed",
    });

    const backendEnvironment = {
      ...baseEnvironment,
      OAUTH_CANONICAL_ORIGIN: backendOrigin,
      OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(backendPort),
      BACKEND_PG_URL: postgresOrigin,
      BETTER_AUTH_SECRET: "native-conduct-0063-disposable-secret-0123456789",
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    };
    backend = start(
      "bun",
      ["run", "--cwd", "apps/backend", "start"],
      backendEnvironment,
      repositoryRoot,
    );
    await waitForHttp(`${backendOrigin}/health`, backend, "native backend");
    proxy = await startProxy(backendOrigin);
    await run("bun", ["run", "--cwd", "packages/sdk", "build"], {
      cwd: repositoryRoot,
      env: backendEnvironment,
      label: "native SDK build",
    });
    const dashboardEnvironment = {
      ...baseEnvironment,
      API_URL: proxy.origin,
      VITE_API_URL: proxy.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      REAL_NATIVE_CONDUCT_E2E: "1",
      CONDUCT_E2E_BROWSER_EVIDENCE_PATH: browserEvidencePath,
      CONDUCT_E2E_SCREENSHOT_DIRECTORY: screenshotDirectory,
      CONDUCT_E2E_APPLICANT_A: "Sofie Gjennomfører",
      CONDUCT_E2E_APPLICANT_B: "Olav Konflikt",
      CONDUCT_E2E_LEADER_EMAIL: "lina.conduct@example.invalid",
      CONDUCT_E2E_LEADER_PASSWORD: "journey-conduct-secret-0123456789",
      CONDUCT_E2E_APPLICANT_EMAIL: "sofie.conduct@example.invalid",
      CONDUCT_E2E_APPLICANT_PASSWORD: "journey-conduct-applicant-secret-0123456789",
    };
    dashboard = start(
      "node",
      [
        "node_modules/@react-router/dev/dist/cli/index.js",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(dashboardPort),
      ],
      dashboardEnvironment,
      dashboardRoot,
    );
    await waitForHttp(`${dashboardOrigin}/login`, dashboard, "dashboard");
    await run(
      "node",
      [
        "./node_modules/@playwright/test/cli.js",
        "test",
        "e2e/native-recruitment-interview-conduct.spec.ts",
        "--project=chromium",
        "--workers=1",
        "--retries=0",
      ],
      { cwd: dashboardRoot, env: dashboardEnvironment, label: "native conduct Chromium journey" },
    );
    const browserEvidence = JSON.parse(await readFile(browserEvidencePath, "utf8"));
    if (
      browserEvidence.firstContextClosed !== true ||
      browserEvidence.independentContextPersisted !== true ||
      browserEvidence.accessibilityViolations !== 0 ||
      browserEvidence.pageErrors.length !== 0 ||
      browserEvidence.rawCapabilityObserved !== false
    )
      throw new Error("browser evidence did not satisfy conduct gates");
    const deliveryOutput = await run(
      "bun",
      ["packages/database/src/completion-receipt-postgres-proof-main.ts"],
      {
        cwd: repositoryRoot,
        env: { ...baseEnvironment, COMPLETION_RECEIPT_PG_URL: postgresOrigin },
        label: "interview completion receipt delivery",
        capture: true,
      },
    );
    const deliveryEvidence = JSON.parse(deliveryOutput.stdout);
    const databaseEvidence = JSON.parse(
      await runPsql(
        `SELECT json_build_object('interviews', (SELECT count(*) FROM recruitment_interviews WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063')), 'schedules', (SELECT count(*) FROM recruitment_interview_schedules WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063')), 'acceptedInvitations', (SELECT count(*) FROM recruitment_invitations WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063') AND response_state = 'Accepted'), 'snapshots', (SELECT count(*) FROM public.recruitment_interview_question_snapshots WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063')), 'conducts', (SELECT count(*) FROM public.recruitment_interview_conducts WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063')), 'cancellations', (SELECT count(*) FROM public.recruitment_interview_cancellations WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063')), 'receipts', (SELECT count(*) FROM public.recruitment_interview_lifecycle_command_receipts WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063')), 'audits', (SELECT count(*) FROM public.recruitment_interview_lifecycle_audit WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063')), 'finalizedReceipts', (SELECT count(*) FROM public.recruitment_interview_lifecycle_command_receipts WHERE interview_id = 'interview-native-conduct-a-0063' AND kind = 'InterviewFinalized'), 'cancelledReceipts', (SELECT count(*) FROM public.recruitment_interview_lifecycle_command_receipts WHERE interview_id = 'interview-native-conduct-b-0063' AND kind = 'InterviewCancelled'), 'finalizedAudits', (SELECT count(*) FROM public.recruitment_interview_lifecycle_audit WHERE interview_id = 'interview-native-conduct-a-0063' AND kind = 'InterviewFinalized'), 'cancelledAudits', (SELECT count(*) FROM public.recruitment_interview_lifecycle_audit WHERE interview_id = 'interview-native-conduct-b-0063' AND kind = 'InterviewCancelled'), 'terminalRevisions', (SELECT coalesce(json_agg(json_build_object('interviewId', interview_id, 'revision', revision) ORDER BY interview_id), '[]'::json) FROM recruitment_interviews WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063')), 'forbiddenFields', (SELECT coalesce(bool_or((command_json::text || observation_json::text) ~* '(responseCapability|responseCode|phone|email)'), false) FROM public.recruitment_interview_lifecycle_command_receipts WHERE interview_id IN ('interview-native-conduct-a-0063','interview-native-conduct-b-0063')));`,
        baseEnvironment,
        "conduct database evidence",
      ),
    );
    if (
      databaseEvidence.interviews !== 2 ||
      databaseEvidence.schedules !== 2 ||
      databaseEvidence.acceptedInvitations !== 2 ||
      databaseEvidence.snapshots !== 8 ||
      databaseEvidence.conducts !== 1 ||
      databaseEvidence.cancellations !== 1 ||
      databaseEvidence.receipts !== 2 ||
      databaseEvidence.audits !== 2 ||
      databaseEvidence.finalizedReceipts !== 1 ||
      databaseEvidence.cancelledReceipts !== 1 ||
      databaseEvidence.finalizedAudits !== 1 ||
      databaseEvidence.cancelledAudits !== 1 ||
      databaseEvidence.forbiddenFields !== false
    )
      throw new Error(`database evidence failed: ${JSON.stringify(databaseEvidence)}`);
    if (proxy.records.some((record) => record.requestHasCapability || record.responseHasCapability))
      throw new Error("native conduct transport exposed response capability");
    const legacyRequests = proxy.records.filter(
      ({ path }) =>
        path === "/interview" ||
        path.startsWith("/api/admin/interviews") ||
        path.includes("schema-admin") ||
        path.includes("/status"),
    );
    if (legacyRequests.length > 0)
      throw new Error(`legacy conduct requests observed: ${JSON.stringify(legacyRequests)}`);
    const staleBackendResponses = proxy.records.filter((record) => {
      if (
        record.method !== "POST" ||
        record.status !== 412 ||
        !record.path.endsWith(":finalize") ||
        record.responseBody === undefined
      )
        return false;
      const body = parseJson(Buffer.from(record.responseBody));
      return (
        body !== undefined &&
        typeof body === "object" &&
        body !== null &&
        "status" in body &&
        body.status === 412 &&
        "code" in body &&
        body.code === "precondition.failed"
      );
    });
    if (staleBackendResponses.length !== 1)
      throw new Error(
        `raw backend stale conflict evidence failed: ${JSON.stringify(
          proxy.records.filter((record) => record.path.endsWith(":finalize")),
        )}`,
      );
    screenshotEvidence = await Promise.all(
      ["interview-completion-desktop.png", "interview-completion-mobile.png"].map(async (name) => ({
        name,
        bytes: await readFile(join(screenshotDirectory, name)),
      })),
    );
    runtimeEvidence = {
      topology: {
        postgres: "disposable-loopback-postgresql",
        backend: backendOrigin,
        dashboard: dashboardOrigin,
        browser: "real-chromium",
        receiptReceiver: "acknowledged-loopback-http",
      },
      browser: browserEvidence,
      completionReceipt: deliveryEvidence,
      postgres: databaseEvidence,
      transport: {
        requests: proxy.records,
        legacyRequests,
        rawCapabilityObserved: false,
      },
    };
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  try {
    await stop(dashboard);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await proxy?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await stop(backend);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (postgres !== undefined)
      await run("pg_ctl", ["-D", postgresRoot, "-m", "fast", "-w", "stop"], {
        cwd: repositoryRoot,
        env: baseEnvironment,
        label: "conduct PostgreSQL cleanup",
      });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError !== undefined && cleanupErrors.length > 0)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "conduct journey and cleanup failed",
    );
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "conduct cleanup failed");
  if (runtimeEvidence === undefined || screenshotEvidence === undefined)
    throw new Error("conduct evidence was not produced");
  const retainedEvidence = { ...runtimeEvidence, cleanup: { disposableResourcesRemoved: true } };
  await withProjectionFileLock(
    join(repositoryRoot, "evidence", "functional-parity"),
    "exclusive",
    async () => {
      for (const { name, bytes } of screenshotEvidence)
        writeFilePathNoFollow(join(evidenceDirectory, name), bytes);
      writeFilePathNoFollow(
        join(evidenceDirectory, "runtime.json"),
        `${JSON.stringify(retainedEvidence, null, 2)}\n`,
      );
    },
  );
  process.stdout.write(`${JSON.stringify(retainedEvidence, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`Real native recruitment conduct runner failed: ${errorDetail(error)}\n`);
  process.exitCode = 1;
});
