import { Predicate } from "effect";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import AxeBuilder from "@axe-core/playwright";
import { startDisposablePostgres } from "@monoweb/postgres";
import { chromium } from "@playwright/test";
import { createPromiseClient } from "@vektorprogrammet/sdk";

import { dashboardMount } from "../dashboard-base.ts";
import { journeyClock } from "../../../tools/e2e/journey-clock.ts";
import { isNativeRequest } from "./native-operations.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));

const seedPath = fileURLToPath(new URL("./native-receipt-settlement-seed.mjs", import.meta.url));

const dashboardRequire = createRequire(new URL("../package.json", import.meta.url));

const { Pool } = dashboardRequire("pg");

const configuredLoopbackPort = (name, fallback) => {
  const value = process.env[name] ?? String(fallback);

  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a decimal TCP port`);
  const port = Number(value);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be between 1 and 65535`);
  }

  return port;
};

const dashboardPort = 5174;

const backendPort = configuredLoopbackPort("RECEIPT_SETTLEMENT_E2E_BACKEND_PORT", 8794);

const postgresPort = configuredLoopbackPort("RECEIPT_SETTLEMENT_E2E_PG_PORT", 55434);

const disposablePorts = [dashboardPort, backendPort, postgresPort];

if (new Set(disposablePorts).size !== disposablePorts.length) {
  throw new Error("Receipt settlement disposable loopback ports must be distinct");
}

const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

const backendOrigin = `http://127.0.0.1:${backendPort}`;

const postgresUrl = `postgres://receipt:receipt@127.0.0.1:${postgresPort}/receipt_proof?connect_timeout=1`;

const commandTimeoutMs = 300_000;

const shutdownTimeoutMs = 5_000;

const settlementRoute = "/dashboard/utlegg/oppgjor";

const privatePaymentDestination = "synthetic-payment-destination-0114-only";

const syntheticPersonaPassword = "receipt-settlement-0114-password";

const pngReceiptBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function assertPortAvailable(port) {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      rejectPort(new Error(`Loopback port ${port} is already in use`));
    });
    socket.once("error", (error) => {
      socket.destroy();

      if (
        error &&
        (error === null || Predicate.isObjectOrArray(error)) &&
        "code" in error &&
        error.code === "ECONNREFUSED"
      ) {
        resolvePort();

        return;
      }

      rejectPort(new Error(`Could not inspect loopback port ${port}`));
    });
  });
}

function runCommand(command, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const captureOutput = options.captureOutput === true;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });

    const stdout = [];
    const stderr = [];

    if (captureOutput) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }

    let settled = false;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs);
      hardKill.unref();

      if (!settled) {
        settled = true;
        rejectCommand(new Error(`${options.label} timed out`));
      }
    }, commandTimeoutMs);

    timeout.unref();

    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectCommand(new Error(`${options.label} could not start`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== null && (options.acceptedExitCodes ?? [0]).includes(code)) {
        resolveCommand(
          captureOutput
            ? {
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
              }
            : undefined,
        );

        return;
      }

      const detail = captureOutput
        ? Buffer.concat(stderr).toString("utf8").trim() ||
          Buffer.concat(stdout).toString("utf8").trim()
        : "";

      rejectCommand(
        new Error(
          `${options.label} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}${detail.length === 0 ? "" : `:\n${detail}`}`,
        ),
      );
    });
  });
}

function startProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });

  child.once("error", () => undefined);

  return child;
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (
      !error ||
      !(error === null || Predicate.isObjectOrArray(error)) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      throw new Error("Could not stop local process group");
    }

    return;
  }

  const stopped = await Promise.race([
    exited.then(() => true),
    sleep(shutdownTimeoutMs).then(() => false),
  ]);

  if (stopped) return;

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (
      !error ||
      !(error === null || Predicate.isObjectOrArray(error)) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      throw new Error("Could not terminate local process group");
    }
  }

  await exited;
}

async function waitForHttp(url, child, label) {
  const deadline = Date.now() + commandTimeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before readiness`);

    try {
      const response = await fetch(url, { redirect: "manual" });

      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // The bounded readiness loop owns transient startup failures.
    }

    await sleep(250);
  }

  throw new Error(`${label} did not become ready`);
}

async function pathExists(path) {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (
      error &&
      (error === null || Predicate.isObjectOrArray(error)) &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

const readIncoming = (request) =>
  new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("error", rejectBody);
    request.once("end", () => resolveBody(Buffer.concat(chunks)));
  });

const parseJson = (bytes) => {
  if (bytes.byteLength === 0) return null;

  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
};

async function startRecordingProxy(targetOrigin) {
  const records = [];

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", targetOrigin);
      const requestBody = await readIncoming(request);
      const headers = new Headers();

      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value === undefined ||
          ["connection", "content-length", "host", "transfer-encoding"].includes(name.toLowerCase())
        )
          continue;
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
      }

      const upstream = await fetch(url, {
        method: request.method,
        headers,
        body: requestBody.byteLength === 0 ? undefined : requestBody,
        redirect: "manual",
      });

      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      records.push({
        method: request.method ?? "GET",
        pathname: url.pathname,
        query: url.search,
        targetOrigin: url.origin,
        requestHeaders: {
          authorization: request.headers.authorization ?? null,
          cookiePresent: Predicate.isString(request.headers.cookie),
          idempotencyKey: request.headers["idempotency-key"] ?? null,
          ifMatch: request.headers["if-match"] ?? null,
          contentType: request.headers["content-type"] ?? null,
        },
        requestJson: parseJson(requestBody),
        responseStatus: upstream.status,
        responseHeaders: {
          etag: upstream.headers.get("etag"),
          contentType: upstream.headers.get("content-type"),
          cacheControl: upstream.headers.get("cache-control"),
        },
        responseJson: parseJson(upstreamBody),
      });
      response.statusCode = upstream.status;

      for (const [name, value] of upstream.headers.entries()) {
        if (
          ["content-encoding", "content-length", "set-cookie", "transfer-encoding"].includes(name)
        )
          continue;
        response.setHeader(name, value);
      }

      const setCookies = upstream.headers.getSetCookie();

      if (setCookies.length > 0) response.setHeader("set-cookie", setCookies);
      response.setHeader("content-length", String(upstreamBody.byteLength));
      response.end(upstreamBody);
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : "proxy failure" }),
      );
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();

  if (address === null || Predicate.isString(address))
    throw new Error("Receipt proxy has no TCP address");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    records,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}

async function startDeliverySink() {
  const deliveries = [];
  let failNextDelivery = false;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const bytes = await readIncoming(request);
    const envelope = parseJson(bytes);

    const loopback =
      request.socket.remoteAddress === "127.0.0.1" || request.socket.remoteAddress === "::1";

    if (
      request.method !== "POST" ||
      url.pathname !== "/receipt-delivery" ||
      !loopback ||
      envelope === null ||
      !Predicate.isObjectOrArray(envelope) ||
      Array.isArray(envelope)
    ) {
      response.writeHead(400);
      response.end();

      return;
    }

    const status = failNextDelivery ? 503 : 204;
    failNextDelivery = false;
    deliveries.push({
      deliveryId: Predicate.isString(envelope.deliveryId) ? envelope.deliveryId : null,
      from: Predicate.isString(envelope.from) ? envelope.from : null,
      to: Predicate.isString(envelope.to) ? envelope.to : null,
      subject: Predicate.isString(envelope.subject) ? envelope.subject : null,
      text: Predicate.isString(envelope.text) ? envelope.text : null,
      status,
      loopback,
    });
    response.writeHead(status);
    response.end();
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();

  if (address === null || Predicate.isString(address))
    throw new Error("Receipt delivery sink has no TCP address");
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    environment: {
      RECEIPT_DELIVERY_URL: `${origin}/receipt-delivery`,
      RECEIPT_DELIVERY_TOKEN: randomBytes(24).toString("base64url"),
      RECEIPT_DELIVERY_TIMEOUT_MS: "5000",
      RECEIPT_DELIVERY_SENDER: "economy@example.invalid",
      RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: JSON.stringify({
        "settlement-department-a-0114": "economy.a.0114@example.invalid",
        "settlement-department-b-0114": "economy.b.0114@example.invalid",
      }),
    },
    deliveries,
    failNext: () => {
      failNextDelivery = true;
    },
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}

function resultBody(result, label) {
  assert.ok(
    result && (result === null || Predicate.isObjectOrArray(result)),
    `${label} did not return an SDK response`,
  );
  assert.ok("body" in result, `${label} SDK response has no body`);
  assert.ok(result.body !== undefined, `${label} SDK response returned no body`);

  return result.body;
}

function nativeHeaders(cookie, headers = {}) {
  const result = new Headers({ Origin: dashboardOrigin });

  if (cookie !== undefined) result.set("Cookie", cookie);

  for (const [name, value] of Object.entries(headers)) result.set(name, value);

  return result;
}

async function requestSettlement(apiOrigin, cookie, receiptId, etag, idempotencyKey, payload) {
  return fetch(`${apiOrigin}/api/receipts/${encodeURIComponent(receiptId)}:settle`, {
    method: "POST",
    headers: nativeHeaders(cookie, {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "if-match": etag,
    }),
    body: JSON.stringify(payload),
  });
}

async function requestFinanceEvidence(apiOrigin, cookie, receiptId) {
  return fetch(`${apiOrigin}/api/receipt-settlement-queue/${encodeURIComponent(receiptId)}`, {
    headers: nativeHeaders(cookie),
  });
}

async function expectProblem(response, expectedStatus, expectedCode, label) {
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${label} status: ${JSON.stringify(body)}`);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/problem\+json/u,
    `${label} must return a native problem document`,
  );
  assert.equal(body?.status, expectedStatus, `${label} problem status`);
  assert.equal(body?.code, expectedCode, `${label} problem code`);
  assert.equal(
    body?.type,
    `urn:vektorprogrammet:problem:v0.2:${expectedCode}`,
    `${label} problem type`,
  );

  return body;
}

async function eventually(operation, predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;

  while (Date.now() < deadline) {
    last = await operation();

    if (predicate(last)) return last;
    await sleep(200);
  }

  throw new Error(`${label} did not converge: ${JSON.stringify(last)}`);
}

async function readWriteCounts(pool) {
  const result = await pool.query(`SELECT json_build_object(
    'receipts', (SELECT count(*)::int FROM economy_receipts),
    'settlements', (SELECT count(*)::int FROM economy_receipt_settlements),
    'commands', (SELECT count(*)::int FROM economy_receipt_command_receipts),
    'audits', (SELECT count(*)::int FROM economy_receipt_audit),
    'outbox', (SELECT count(*)::int FROM economy_receipt_outbox)
  ) AS evidence`);

  return result.rows[0]?.evidence;
}

async function readReceiptEvidence(pool, receiptId) {
  const result = await pool.query(
    `SELECT json_build_object(
      'receipt', (
        SELECT json_build_object(
          'receiptId', receipt_id,
          'visualId', visual_id,
          'ownerPersonId', owner_person_id,
          'departmentId', department_id,
          'amountOre', amount_ore::text,
          'currency', currency,
          'status', status,
          'approvedAt', CASE WHEN approved_at IS NULL THEN NULL ELSE to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
          'revision', revision
        )
        FROM economy_receipts WHERE receipt_id = $1
      ),
      'settlements', COALESCE((
        SELECT json_agg(json_build_object(
          'settlementId', settlement_id,
          'receiptId', receipt_id,
          'amountOre', amount_ore::text,
          'currency', currency,
          'paymentDestinationFingerprint', payment_destination_fingerprint,
          'externalAuthority', external_authority,
          'externalReference', external_reference,
          'settledAt', to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'recordedByPersonId', recorded_by_person_id,
          'recordedAt', to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'receiptRevision', receipt_revision
        ) ORDER BY settlement_id)
        FROM economy_receipt_settlements WHERE receipt_id = $1
      ), '[]'::json),
      'audits', COALESCE((
        SELECT json_agg(json_build_object(
          'commandId', command_id,
          'action', action,
          'actorPersonId', actor_person_id,
          'receiptRevision', receipt_revision
        ) ORDER BY occurred_at, command_id)
        FROM economy_receipt_audit WHERE receipt_id = $1
      ), '[]'::json),
      'outbox', COALESCE((
        SELECT json_agg(json_build_object(
          'effectId', effect_id,
          'effectType', effect_type,
          'commandId', command_id,
          'ordinal', ordinal,
          'status', status,
          'attempts', attempts
        ) ORDER BY command_id, ordinal)
        FROM economy_receipt_outbox WHERE receipt_id = $1
      ), '[]'::json)
    ) AS evidence`,
    [receiptId],
  );

  return result.rows[0]?.evidence;
}

function receiptById(items, receiptId, label) {
  const receipt = items.find((item) => item?.receiptId === receiptId);
  assert.ok(receipt, `${label} omitted ${receiptId}`);

  return receipt;
}

async function login(browser, persona) {
  const context = await browser.newContext({
    baseURL: dashboardOrigin,
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  const loginUrl = new URL(`${dashboardMount({})}login`, dashboardOrigin).toString();
  await page.goto(loginUrl);
  await page.getByLabel("E-post").fill(persona.email);
  await page.getByLabel("Passord", { exact: true }).fill(persona.password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click({ noWaitAfter: true });
  await page.waitForURL((url) => url.pathname === "/dashboard" || url.pathname === "/dashboard/", {
    timeout: 15_000,
    waitUntil: "commit",
  });

  const sessionCookies = (await context.cookies(dashboardOrigin)).filter(
    ({ name }) =>
      name === "better-auth.session_token" || name === "__Secure-better-auth.session_token",
  );

  assert.equal(
    sessionCookies.length,
    1,
    `${persona.personId} must have one Better Auth session cookie`,
  );
  const sessionCookie = sessionCookies[0];
  assert.ok(sessionCookie, `${persona.personId} session cookie is missing`);
  const cookie = `${sessionCookie.name}=${sessionCookie.value}`;

  const sessionResponse = await fetch(`${backendOrigin}/api/session`, {
    headers: nativeHeaders(cookie),
  });

  assert.equal(sessionResponse.status, 200, `${persona.personId} native session read`);
  const session = await sessionResponse.json();
  assert.equal(
    session?.personId,
    persona.personId,
    `${persona.personId} canonical session binding`,
  );

  return {
    context,
    page,
    cookie,
    browserCookie: {
      name: sessionCookie.name,
      value: sessionCookie.value,
      url: dashboardOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
    persona,
  };
}

async function submitReceiptFromDashboard(page, description) {
  await page.goto(`${dashboardOrigin}/dashboard/mine-utlegg`);
  const form = page.getByRole("form", { name: "Send inn utlegg" });
  await form.getByLabel(/Beskrivelse/u).fill(description);
  await form.locator("#amountNok").fill("125,50");
  await form.getByLabel(/Kvitteringsdato/u).fill("2026-09-20");
  await form.getByLabel(/Kvitteringsfil/u).setInputFiles({
    name: "settlement-proof.png",
    mimeType: "image/png",
    buffer: pngReceiptBytes,
  });
  await form.getByRole("button", { name: "Send inn utlegg", exact: true }).click();
}

async function main() {
  await Promise.all(disposablePorts.map(assertPortAvailable));

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-receipt-settlement-0114-"));
  const stagingRoot = join(temporaryRoot, "staging");
  const committedRoot = join(temporaryRoot, "committed");
  const postgresDataRoot = join(temporaryRoot, "postgres");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);

  const baseEnvironment = { ...process.env };

  for (const name of [
    "API_MODE",
    "VITE_API_MODE",
    "ADMISSION_AUTH_TOKENS",
    "ORGANIZATION_AUTH_TOKENS",
    "RECEIPT_AUTH_TOKENS",
    "RECEIPT_E2E_TOKEN",
    "RECEIPT_E2E_FOREIGN_TOKEN",
    "RECEIPT_DELIVERY_URL",
    "RECEIPT_DELIVERY_TOKEN",
    "RECEIPT_DELIVERY_TIMEOUT_MS",
    "RECEIPT_DELIVERY_SENDER",
    "RECEIPT_DELIVERY_ECONOMY_RECIPIENTS",
  ]) {
    delete baseEnvironment[name];
  }

  const forbiddenProviderConfiguration = [
    "BANK_PROVIDER_URL",
    "PAYMENT_PROVIDER_URL",
    "PAYMENT_GATEWAY_URL",
    "STRIPE_SECRET_KEY",
    "VIPPS_CLIENT_SECRET",
    "NETS_SECRET_KEY",
  ].filter((name) => baseEnvironment[name] !== undefined);

  assert.deepEqual(
    forbiddenProviderConfiguration,
    [],
    "The disposable settlement runtime must not inherit a payment-provider configuration",
  );

  const sharedEnvironment = {
    ...baseEnvironment,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
  };

  let postgres;
  let backendProcess;
  let dashboardProcess;
  let proxy;
  let deliverySink;
  let pool;
  let browser;
  const sessions = [];
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const errors = [];

    for (const session of sessions) {
      try {
        await session.context.close();
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await browser?.close();
    } catch (error) {
      errors.push(error);
    }

    try {
      await stopProcess(dashboardProcess);
    } catch (error) {
      errors.push(error);
    }

    try {
      await stopProcess(backendProcess);
    } catch (error) {
      errors.push(error);
    }

    try {
      await pool?.end();
    } catch (error) {
      errors.push(error);
    }

    try {
      await proxy?.close();
    } catch (error) {
      errors.push(error);
    }

    try {
      await deliverySink?.close();
    } catch (error) {
      errors.push(error);
    }

    try {
      await postgres?.stop();
    } catch (error) {
      errors.push(error);
    }

    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0)
      throw new AggregateError(errors, "Receipt settlement runtime cleanup failed");
  };

  const interrupt = (signal) => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };

  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  let evidence;
  let primaryError;

  try {
    postgres = await startDisposablePostgres({
      user: "receipt",
      database: "receipt_proof",
      port: postgresPort,
      directory: postgresDataRoot,
    });

    const seedRun = await runCommand("bun", [seedPath], {
      cwd: repositoryRoot,
      env: { ...sharedEnvironment, RECEIPT_SETTLEMENT_PG_URL: postgresUrl },
      label: "Native receipt settlement direct PostgreSQL seed",
      captureOutput: true,
    });

    const seed = JSON.parse(seedRun.stdout.trim().split(/\r?\n/u).at(-1));
    assert.equal(
      seed.fixtureCounts.settlementGrants,
      4,
      "Seed must include independent settlement grants",
    );
    assert.equal(
      seed.fixtureCounts.approvalGrants,
      1,
      "Seed must include a separate approval grant",
    );
    assert.equal(
      seed.paymentDestinationFingerprint.length,
      64,
      "Seed fingerprint must be SHA-256 hex",
    );

    deliverySink = await startDeliverySink();

    const backendEnvironment = {
      ...sharedEnvironment,
      ...deliverySink.environment,
      OAUTH_CANONICAL_ORIGIN: backendOrigin,
      OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(backendPort),
      BACKEND_PG_URL: postgresUrl,
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      PASSWORD_RESET_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_MODE: "disabled",
      RECEIPT_STAGING_ROOT: stagingRoot,
      RECEIPT_COMMITTED_ROOT: committedRoot,
      RECEIPT_MAX_FILE_BYTES: "10485760",
      RECEIPT_E2E_TEST_MODE: "1",
    };

    const startBackend = () => {
      const configuredCommand = process.env.BACKEND_COMMAND;

      return configuredCommand
        ? startProcess("/bin/sh", ["-c", configuredCommand], {
            cwd: repositoryRoot,
            env: backendEnvironment,
          })
        : startProcess("bun", ["run", "--cwd", "apps/backend", "start"], {
            cwd: repositoryRoot,
            env: backendEnvironment,
          });
    };

    backendProcess = startBackend();
    await waitForHttp(`${backendOrigin}/health`, backendProcess, "Native Effect backend");
    proxy = await startRecordingProxy(backendOrigin);

    const dashboardEnvironment = {
      ...sharedEnvironment,
      API_URL: proxy.origin,
      VITE_API_URL: proxy.origin,
      VITE_DASHBOARD_ORIGIN: dashboardOrigin,
      BACKEND_ORIGIN: proxy.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      REAL_RECEIPT_SETTLEMENT_E2E: "1",
      HOST: "127.0.0.1",
      PORT: String(dashboardPort),
    };

    await runCommand("bun", ["run", "build"], {
      cwd: dashboardRoot,
      env: dashboardEnvironment,
      label: "Native receipt settlement production dashboard build",
    });
    dashboardProcess = startProcess("bun", ["run", "start"], {
      cwd: dashboardRoot,
      env: dashboardEnvironment,
    });
    await waitForHttp(
      new URL(`${dashboardMount(dashboardEnvironment)}login`, dashboardOrigin).toString(),
      dashboardProcess,
      "Production dashboard server",
    );

    pool = new Pool({
      connectionString: postgresUrl,
      options: "-c search_path=auth,public",
      max: 2,
      application_name: "native-receipt-settlement-runtime-0114",
    });
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        "/etc/profiles/per-user/nori/bin/chromium-browser",
    });
    const browserRequestOrigins = [];

    const recordBrowserRequest = (request) => {
      browserRequestOrigins.push(new URL(request.url()).origin);
    };

    const personaById = new Map(seed.personas.map((persona) => [persona.personId, persona]));

    const requirePersona = (personId) => {
      const persona = personaById.get(personId);
      assert.ok(persona, `Seed omitted ${personId}`);

      return { ...persona, password: syntheticPersonaPassword };
    };

    const owner = await login(browser, requirePersona("settlement-owner-0114"));
    const approver = await login(browser, requirePersona("settlement-approver-0114"));
    const settler = await login(browser, requirePersona("settlement-settler-0114"));
    const ordinary = await login(browser, requirePersona("settlement-ordinary-0114"));
    const inactiveSettler = await login(browser, requirePersona("settlement-inactive-0114"));
    const expiredSettler = await login(browser, requirePersona("settlement-expired-0114"));
    const foreignSettler = await login(browser, requirePersona("settlement-foreign-0114"));
    sessions.push(
      owner,
      approver,
      settler,
      ordinary,
      inactiveSettler,
      expiredSettler,
      foreignSettler,
    );

    for (const session of sessions) session.context.on("request", recordBrowserRequest);

    const ownerSdk = createPromiseClient(proxy.origin, {
      cookie: owner.cookie,
      origin: dashboardOrigin,
    });

    const approverSdk = createPromiseClient(proxy.origin, {
      cookie: approver.cookie,
      origin: dashboardOrigin,
    });

    const settlerSdk = createPromiseClient(proxy.origin, {
      cookie: settler.cookie,
      origin: dashboardOrigin,
    });

    const listOwned = async () =>
      resultBody(await ownerSdk.receipts.listReceipts({ query: {} }), "list owned receipts");

    const listSettlementQueue = async () =>
      resultBody(
        await settlerSdk.receipts.listReceiptsForSettlement({ query: {} }),
        "list settlement queue",
      );

    const readFinanceSettlement = async (receiptId) =>
      resultBody(
        await settlerSdk.receipts.readReceiptSettlementForFinance({ params: { receiptId } }),
        "read settlement evidence for finance",
      );

    const initialOwnerProjection = await listOwned();
    assert.ok(
      Array.isArray(initialOwnerProjection?.items),
      `Initial owner projection is unavailable: ${JSON.stringify(initialOwnerProjection)}`,
    );

    const claimDescription = "Expense claim approved before settlement evidence 0114";
    await submitReceiptFromDashboard(owner.page, claimDescription);

    const ownedAfterSubmission = await eventually(
      listOwned,
      (body) =>
        Array.isArray(body?.items) &&
        body.items.some((item) => item?.description === claimDescription),
      "dashboard receipt submission",
    );

    const submittedReceipt = ownedAfterSubmission.items.find(
      (item) => item?.description === claimDescription,
    );

    assert.ok(submittedReceipt, "Submitted receipt is missing from owner projection");
    assert.equal(submittedReceipt.status, "Pending", "Dashboard submission begins pending");
    assert.equal(submittedReceipt.revision, 0, "Dashboard submission begins at revision zero");

    const approvalKey = randomUUID();

    const approvedResult = resultBody(
      await approverSdk.receipts.approveReceipt({
        params: { receiptId: submittedReceipt.receiptId },
        headers: { "idempotency-key": approvalKey, "if-match": submittedReceipt.etag },
        payload: {},
      }),
      "approve receipt through generated SDK",
    );

    assert.equal(approvedResult.status, "Approved", "Approval changes the claim decision only");
    assert.equal(approvedResult.revision, 1, "Approval increments the receipt revision once");
    assert.equal(
      Predicate.isString(approvedResult.approvedAt),
      true,
      "Approval records approvedAt",
    );
    assert.equal(
      JSON.stringify(approvedResult).includes("settlementId"),
      false,
      "Approval response has no settlement evidence",
    );

    const ownerAfterApproval = receiptById(
      (await listOwned()).items,
      submittedReceipt.receiptId,
      "owner after approval",
    );

    assert.equal(
      ownerAfterApproval.status,
      "Approved",
      "Owner sees an approved claim before settlement",
    );
    assert.equal(ownerAfterApproval.revision, 1, "Owner sees the approval revision");
    assert.equal(
      JSON.stringify(ownerAfterApproval).includes("paymentDestinationFingerprint"),
      false,
      "Owner approval projection has no settlement evidence",
    );
    const approvalPersistence = await readReceiptEvidence(pool, submittedReceipt.receiptId);
    assert.equal(
      approvalPersistence.receipt.status,
      "Approved",
      "PostgreSQL records approval before settlement",
    );
    assert.equal(
      approvalPersistence.receipt.revision,
      1,
      "Approval persistence advances exactly one revision",
    );
    assert.deepEqual(
      approvalPersistence.settlements,
      [],
      "Approval persistence creates no settlement evidence",
    );
    assert.equal(
      approvalPersistence.audits.some(({ action }) => action === "ReceiptSettled"),
      false,
      "Approval persistence writes no settlement audit",
    );

    const queueBeforeSettlement = await listSettlementQueue();

    const queuedReceipt = receiptById(
      queueBeforeSettlement.items,
      submittedReceipt.receiptId,
      "independently authorized settler queue",
    );

    assert.equal(
      queuedReceipt.status,
      "Approved",
      "Settlement queue shows only the approved source",
    );
    assert.equal(queuedReceipt.revision, 1, "Settlement queue exposes the approval revision");
    assert.notEqual(
      settler.persona.personId,
      owner.persona.personId,
      "Settler must be a different person from owner",
    );
    assert.notEqual(
      settler.persona.personId,
      approver.persona.personId,
      "Settlement grant must be separate from approval grant",
    );

    const queuePath = `${proxy.origin}/api/receipt-settlement-queue`;
    const denialCountsBefore = await readWriteCounts(pool);

    const settlementAttemptPayload = (reference, expectedRevision = approvedResult.revision) => ({
      externalAuthority: "External settlement authority",
      expectedRevision,
      externalReference: reference,
      settledAt: "2026-09-21T10:00:00.000Z",
    });

    const denials = [];

    for (const [label, cookie, queueStatus, denialStatus, denialCode] of [
      ["anonymous", undefined, 401, 401, "credential.missing"],
      [
        "invalid credential",
        "better-auth.session_token=invalid-settlement-session",
        401,
        401,
        "credential.invalid",
      ],
      ["ordinary member", ordinary.cookie, 200, 404, "receipt.not-found"],
      ["receipt owner", owner.cookie, 200, 404, "receipt.not-found"],
      ["approval-only actor", approver.cookie, 200, 404, "receipt.not-found"],
      ["inactive settlement grantee", inactiveSettler.cookie, 200, 404, "receipt.not-found"],
      ["expired settlement grantee", expiredSettler.cookie, 200, 404, "receipt.not-found"],
      ["wrong department settlement grantee", foreignSettler.cookie, 200, 404, "receipt.not-found"],
    ]) {
      const queueResponse = await fetch(queuePath, { headers: nativeHeaders(cookie) });
      const queueRecord = proxy.records.at(-1);
      assert.equal(
        queueRecord?.requestHeaders.cookiePresent,
        cookie !== undefined,
        `${label} queue credential transport`,
      );

      if (queueStatus === 200) {
        assert.equal(queueResponse.status, 200, `${label} settlement queue status`);
        const queueBody = await queueResponse.json();
        assert.equal(
          Array.isArray(queueBody?.items) &&
            queueBody.items.some(({ receiptId }) => receiptId === submittedReceipt.receiptId),
          false,
          `${label} queue conceals the target receipt`,
        );
      } else {
        await expectProblem(queueResponse, queueStatus, denialCode, `${label} settlement queue`);
      }

      const financeResponse = await requestFinanceEvidence(
        proxy.origin,
        cookie,
        submittedReceipt.receiptId,
      );

      await expectProblem(
        financeResponse,
        denialStatus,
        denialCode,
        `${label} settlement evidence`,
      );

      const commandResponse = await requestSettlement(
        proxy.origin,
        cookie,
        submittedReceipt.receiptId,
        approvedResult.etag,
        randomUUID(),
        settlementAttemptPayload(`denied-${label.replaceAll(" ", "-")}-0114`),
      );

      await expectProblem(commandResponse, denialStatus, denialCode, `${label} settlement command`);
      denials.push({
        label,
        queue: queueStatus,
        command: denialStatus,
        evidence: denialStatus,
        code: denialCode,
      });
    }

    const unknownReceiptId = `unknown-settlement-receipt-${randomUUID()}`;

    const unknownResponse = await requestSettlement(
      proxy.origin,
      settler.cookie,
      unknownReceiptId,
      approvedResult.etag,
      randomUUID(),
      settlementAttemptPayload("unknown-settlement-reference-0114"),
    );

    await expectProblem(
      unknownResponse,
      404,
      "receipt.not-found",
      "unknown receipt settlement concealment",
    );

    const unknownEvidenceResponse = await requestFinanceEvidence(
      proxy.origin,
      settler.cookie,
      unknownReceiptId,
    );

    await expectProblem(
      unknownEvidenceResponse,
      404,
      "receipt.not-found",
      "unknown receipt settlement evidence concealment",
    );
    assert.deepEqual(
      await readWriteCounts(pool),
      denialCountsBefore,
      "Denied settlement attempts write nothing",
    );

    const ownerSeededItems = (await listOwned()).items;

    const seededReceipt = (kind) =>
      receiptById(ownerSeededItems, seed.seededReceiptIds[kind], `seeded ${kind} receipt`);

    for (const [kind, expectedCode] of [
      ["pending", "receipt.invalid-transition"],
      ["rejected", "receipt.invalid-transition"],
      ["withdrawn", "receipt.invalid-transition"],
      ["alreadySettled", "receipt.already-settled"],
    ]) {
      const receipt = seededReceipt(kind);
      const countsBefore = await readWriteCounts(pool);

      const response = await requestSettlement(
        proxy.origin,
        settler.cookie,
        receipt.receiptId,
        receipt.etag,
        randomUUID(),
        settlementAttemptPayload(`${kind}-invalid-source-0114`, receipt.revision),
      );

      await expectProblem(response, 409, expectedCode, `${kind} receipt cannot settle`);
      assert.deepEqual(
        await readWriteCounts(pool),
        countsBefore,
        `${kind} failure creates no evidence`,
      );
    }

    const duplicateCandidate = seededReceipt("duplicateExternalReference");

    const futureSettlement = await requestSettlement(
      proxy.origin,
      settler.cookie,
      duplicateCandidate.receiptId,
      duplicateCandidate.etag,
      randomUUID(),
      {
        externalAuthority: "External settlement authority",
        expectedRevision: duplicateCandidate.revision,
        externalReference: "future-settlement-reference-0114",
        // A year after the run, so the backend's record always lies before it.
        settledAt: journeyClock(new Date().toISOString()).fromNow(365),
      },
    );

    await expectProblem(
      futureSettlement,
      422,
      "settlement.after-recorded-at",
      "future settlement instant",
    );

    const mobileContext = await browser.newContext({
      baseURL: dashboardOrigin,
      viewport: { width: 390, height: 844 },
    });

    mobileContext.on("request", recordBrowserRequest);
    await mobileContext.addCookies([settler.browserCookie]);
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`${dashboardOrigin}${settlementRoute}`);
    await mobilePage.getByRole("heading", { name: /oppgjør/u }).waitFor();

    const mobileOverflow = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );

    assert.equal(mobileOverflow, true, "Settlement queue fits a 390-pixel viewport");
    await mobileContext.close();

    await settler.page.goto(`${dashboardOrigin}${settlementRoute}`);
    await settler.page.getByRole("heading", { name: /oppgjør/u }).waitFor();
    const settlementList = settler.page.getByTestId("receipt-settlement-list");
    await settlementList.waitFor();

    const queueRow = settlementList.locator(
      `tr[data-receipt-id=${JSON.stringify(submittedReceipt.receiptId)}]`,
    );

    await queueRow.waitFor();
    const openSettlement = queueRow.getByTestId("record-receipt-settlement");
    assert.equal(await openSettlement.innerText(), "Registrer oppgjør", "Settlement action text");
    await openSettlement.focus();
    await settler.page.keyboard.press("Enter");
    const confirmation = settler.page.locator("[data-receipt-settlement-dialog]");
    await confirmation.waitFor();
    assert.ok(
      ["dialog", "alertdialog"].includes(await confirmation.getAttribute("role")),
      "Settlement confirmation has dialog semantics",
    );
    const settlementForm = confirmation.locator('form[data-receipt-settlement="record"]');
    await settlementForm.waitFor();
    const enteredAuthority = "  External settlement authority  ";
    const enteredReference = "  browser-settlement-reference-0114  ";
    const normalizedAuthority = enteredAuthority.trim();
    const normalizedReference = enteredReference.trim();
    const settledAtInput = "2026-09-21T10:00";
    const settledAt = "2026-09-21T10:00:00.000Z";
    await settlementForm.getByTestId("settlement-external-authority").fill(enteredAuthority);
    await settlementForm.getByTestId("settlement-external-reference").fill(enteredReference);
    await settlementForm.getByTestId("settlement-settled-at").fill(settledAtInput);
    const confirmationText = await confirmation.innerText();
    assert.match(confirmationText, /125(?:,|\.)50/u);
    assert.match(confirmationText, new RegExp(submittedReceipt.visualId, "u"));
    assert.match(confirmationText, /browser-settlement-reference-0114/u);

    const axe = await new AxeBuilder({ page: settler.page })
      .include("[data-receipt-settlement-dialog]")
      .analyze();

    assert.deepEqual(
      axe.violations.map(({ id }) => id),
      [],
      "Settlement confirmation has no blocking accessibility violations",
    );

    const confirmationButton = confirmation.getByRole("button", {
      name: "Bekreft oppgjør",
      exact: true,
    });

    await confirmationButton.focus();
    await confirmationButton.press("Enter");
    const settlementSuccess = settler.page.getByTestId("receipt-settlement-success");
    await settlementSuccess.waitFor();
    assert.match(
      await settlementSuccess.innerText(),
      /browser-settlement-reference-0114/u,
      "Settlement success renders the immutable external reference",
    );
    const settlementDetailLink = settlementSuccess.getByTestId("read-receipt-settlement");
    assert.equal(
      await settlementDetailLink.getAttribute("href"),
      `${settlementRoute}/${encodeURIComponent(submittedReceipt.receiptId)}`,
      "Settlement success links to reloadable finance evidence",
    );
    await settlementDetailLink.click();
    await settler.page.waitForURL(
      (url) =>
        url.pathname === `${settlementRoute}/${encodeURIComponent(submittedReceipt.receiptId)}`,
    );
    await settler.page.getByTestId("receipt-settlement-evidence").waitFor();

    const canonicalRecord = await eventually(
      async () => {
        const records = proxy.records.filter(
          (record) =>
            record.method === "POST" &&
            record.pathname ===
              `/api/receipts/${encodeURIComponent(submittedReceipt.receiptId)}:settle`,
        );

        return records.find(
          (record) =>
            record.responseStatus === 200 &&
            record.requestJson?.externalReference?.trim() === normalizedReference,
        );
      },
      (record) => record !== undefined,
      "dashboard settlement command through the real backend",
    );

    assert.equal(
      canonicalRecord.requestHeaders.ifMatch,
      approvedResult.etag,
      "Dashboard sends the visible approval revision",
    );
    assert.equal(
      Predicate.isString(canonicalRecord.requestHeaders.idempotencyKey),
      true,
      "Dashboard sends an idempotency key",
    );
    assert.deepEqual(
      Object.keys(canonicalRecord.requestJson).sort(),
      ["expectedRevision", "externalAuthority", "externalReference", "settledAt"],
      "Dashboard sends the external settlement facts and visible revision",
    );
    assert.equal(
      canonicalRecord.requestJson.expectedRevision,
      approvedResult.revision,
      "Dashboard sends the visible receipt revision in the request body",
    );
    assert.equal(
      canonicalRecord.requestJson.externalAuthority.trim(),
      normalizedAuthority,
      "Dashboard sends the entered external authority",
    );
    assert.equal(
      canonicalRecord.requestJson.externalReference.trim(),
      normalizedReference,
      "Dashboard sends the entered external reference",
    );
    assert.equal(
      new Date(canonicalRecord.requestJson.settledAt).toISOString(),
      settledAt,
      "Dashboard sends the entered UTC settlement instant",
    );
    assert.equal(
      canonicalRecord.responseHeaders.cacheControl,
      "private, no-store",
      "Settlement response is private",
    );
    assert.ok(canonicalRecord.responseHeaders.etag, "Settlement response carries a fresh ETag");

    const canonicalEvidence = await eventually(
      () => readReceiptEvidence(pool, submittedReceipt.receiptId),
      (state) => state?.settlements?.length === 1,
      "canonical settlement persistence",
    );

    const canonicalSettlement = canonicalEvidence.settlements[0];
    assert.deepEqual(
      {
        receiptId: canonicalSettlement.receiptId,
        amountOre: canonicalSettlement.amountOre,
        currency: canonicalSettlement.currency,
        paymentDestinationFingerprint: canonicalSettlement.paymentDestinationFingerprint,
        externalAuthority: canonicalSettlement.externalAuthority,
        externalReference: canonicalSettlement.externalReference,
        settledAt: canonicalSettlement.settledAt,
        recordedByPersonId: canonicalSettlement.recordedByPersonId,
        receiptRevision: canonicalSettlement.receiptRevision,
      },
      {
        receiptId: submittedReceipt.receiptId,
        amountOre: "12550",
        currency: "NOK",
        paymentDestinationFingerprint: seed.paymentDestinationFingerprint,
        externalAuthority: normalizedAuthority,
        externalReference: normalizedReference,
        settledAt,
        recordedByPersonId: settler.persona.personId,
        receiptRevision: 2,
      },
      "PostgreSQL settlement evidence is immutable and copied from the approved claim",
    );
    assert.match(canonicalSettlement.settlementId, /\S/u, "Server issued a settlement identity");
    assert.match(
      canonicalSettlement.recordedAt,
      /^\d{4}-\d{2}-\d{2}T/u,
      "Server recorded the settlement instant",
    );
    assert.ok(
      Date.parse(canonicalSettlement.recordedAt) >= Date.parse(canonicalSettlement.settledAt),
      "Recorded time is not before external settlement time",
    );
    assert.equal(
      canonicalEvidence.receipt.status,
      "Approved",
      "Settlement leaves the approval decision intact",
    );
    assert.equal(
      canonicalEvidence.receipt.revision,
      2,
      "Settlement increments the receipt revision",
    );

    const canonicalSettlementAudits = canonicalEvidence.audits.filter(
      (audit) => audit.action === "ReceiptSettled",
    );

    assert.deepEqual(
      canonicalSettlementAudits.map((audit) => audit.receiptRevision),
      [2],
      "Settlement creates exactly one receipt audit",
    );

    const canonicalSettlementOutbox = canonicalEvidence.outbox.filter(
      (row) => row.effectType === "NotifyReceiptSettled",
    );

    assert.deepEqual(
      canonicalSettlementOutbox.map(({ effectId, ordinal }) => ({ effectId, ordinal })),
      [
        {
          effectId: `${canonicalSettlementAudits[0].commandId}:NotifyReceiptSettled`,
          ordinal: 0,
        },
      ],
      "Settlement atomically creates one owner-notification outbox work item",
    );

    const ownerAfterSettlement = receiptById(
      (await listOwned()).items,
      submittedReceipt.receiptId,
      "owner settlement projection",
    );

    assert.equal(
      ownerAfterSettlement.status,
      "Approved",
      "Owner claim decision remains approved after settlement",
    );
    assert.ok(
      ownerAfterSettlement.settlement,
      "Owner list projection embeds separate settlement evidence",
    );
    assert.equal(
      ownerAfterSettlement.settlement.settlementId,
      canonicalSettlement.settlementId,
      "Owner list identifies the canonical settlement",
    );
    const financeSettlementResponse = await readFinanceSettlement(submittedReceipt.receiptId);

    const financeSettlementDetail =
      financeSettlementResponse.settlement ?? financeSettlementResponse;

    for (const [label, projection] of [
      ["owner list", ownerAfterSettlement.settlement],
      ["finance detail", financeSettlementDetail],
    ]) {
      const serializedProjection = JSON.stringify(projection);

      for (const value of [
        canonicalSettlement.settlementId,
        submittedReceipt.receiptId,
        normalizedAuthority,
        normalizedReference,
        seed.paymentDestinationFingerprint,
        settler.persona.personId,
      ]) {
        assert.equal(
          serializedProjection.includes(value),
          true,
          `${label} exposes immutable settlement evidence`,
        );
      }

      assert.equal(
        serializedProjection.includes(privatePaymentDestination),
        false,
        `${label} never exposes payment destination ciphertext`,
      );
    }

    await owner.page.goto(`${dashboardOrigin}/dashboard/mine-utlegg`);
    await owner.page.reload();

    const ownerReceiptRow = owner.page.locator(
      `tr[data-receipt-settlement][data-receipt-id=${JSON.stringify(submittedReceipt.receiptId)}]`,
    );

    await ownerReceiptRow.waitFor();
    const ownerEvidenceElement = ownerReceiptRow.getByTestId("receipt-settlement-evidence");
    await ownerEvidenceElement.waitFor();
    const ownerRendered = await ownerEvidenceElement.innerText();
    assert.equal(
      ownerRendered.includes(normalizedReference),
      true,
      "Owner dashboard renders settlement evidence after reload",
    );
    assert.equal(
      ownerRendered.includes(privatePaymentDestination),
      false,
      "Owner dashboard never renders payment destination ciphertext",
    );

    const financeDetailPath = `${settlementRoute}/${encodeURIComponent(submittedReceipt.receiptId)}`;
    await settler.page.goto(`${dashboardOrigin}${financeDetailPath}`);
    const financeEvidenceElement = settler.page.getByTestId("receipt-settlement-evidence");
    await financeEvidenceElement.waitFor();
    await settler.page.reload();
    await financeEvidenceElement.waitFor();
    const financeRendered = await financeEvidenceElement.innerText();
    assert.equal(
      financeRendered.includes(normalizedReference),
      true,
      "Finance dashboard renders settlement evidence after reload",
    );
    assert.equal(
      financeRendered.includes(seed.paymentDestinationFingerprint),
      true,
      "Finance dashboard renders the destination fingerprint",
    );
    assert.equal(
      financeRendered.includes(privatePaymentDestination),
      false,
      "Finance dashboard never renders payment destination ciphertext",
    );
    assert.ok(
      proxy.records.filter(
        (record) =>
          record.method === "GET" &&
          record.pathname ===
            `/api/receipt-settlement-queue/${encodeURIComponent(submittedReceipt.receiptId)}` &&
          record.responseStatus === 200,
      ).length >= 2,
      "Finance detail is read through the concealed backend projection before and after reload",
    );

    const replayCountsBefore = await readWriteCounts(pool);

    const replayResponse = await requestSettlement(
      proxy.origin,
      settler.cookie,
      submittedReceipt.receiptId,
      approvedResult.etag,
      canonicalRecord.requestHeaders.idempotencyKey,
      canonicalRecord.requestJson,
    );

    assert.equal(replayResponse.status, 200, "Idempotent settlement replay succeeds");
    const replayEvidence = await replayResponse.json();
    assert.deepEqual(
      replayEvidence,
      canonicalRecord.responseJson,
      "Idempotent replay returns the byte-equivalent first settlement resource",
    );
    assert.deepEqual(
      await readWriteCounts(pool),
      replayCountsBefore,
      "Idempotent replay writes nothing",
    );

    const changedReplayResponse = await requestSettlement(
      proxy.origin,
      settler.cookie,
      submittedReceipt.receiptId,
      approvedResult.etag,
      canonicalRecord.requestHeaders.idempotencyKey,
      { ...canonicalRecord.requestJson, externalReference: "changed-replay-reference-0114" },
    );

    await expectProblem(
      changedReplayResponse,
      409,
      "idempotency.digest-conflict",
      "changed settlement replay",
    );

    const staleRevisionResponse = await requestSettlement(
      proxy.origin,
      settler.cookie,
      submittedReceipt.receiptId,
      approvedResult.etag,
      randomUUID(),
      settlementAttemptPayload("stale-revision-reference-0114"),
    );

    await expectProblem(
      staleRevisionResponse,
      412,
      "precondition.failed",
      "stale settlement revision",
    );

    const alreadySettledResponse = await requestSettlement(
      proxy.origin,
      settler.cookie,
      submittedReceipt.receiptId,
      canonicalRecord.responseHeaders.etag,
      randomUUID(),
      settlementAttemptPayload(
        "second-settlement-reference-0114",
        canonicalEvidence.receipt.revision,
      ),
    );

    await expectProblem(
      alreadySettledResponse,
      409,
      "receipt.already-settled",
      "second settlement evidence",
    );

    const duplicateReferenceResponse = await requestSettlement(
      proxy.origin,
      settler.cookie,
      duplicateCandidate.receiptId,
      duplicateCandidate.etag,
      randomUUID(),
      {
        externalAuthority: normalizedAuthority,
        expectedRevision: duplicateCandidate.revision,
        externalReference: normalizedReference,
        settledAt,
      },
    );

    await expectProblem(
      duplicateReferenceResponse,
      409,
      "settlement.external-reference-conflict",
      "duplicate external settlement reference",
    );

    const concurrentCandidate = seededReceipt("concurrent");
    const concurrentKey = randomUUID();

    const concurrentPayload = settlementAttemptPayload(
      "concurrent-settlement-reference-0114",
      concurrentCandidate.revision,
    );

    const concurrentResponses = await Promise.all([
      requestSettlement(
        proxy.origin,
        settler.cookie,
        concurrentCandidate.receiptId,
        concurrentCandidate.etag,
        concurrentKey,
        concurrentPayload,
      ),
      requestSettlement(
        proxy.origin,
        settler.cookie,
        concurrentCandidate.receiptId,
        concurrentCandidate.etag,
        concurrentKey,
        concurrentPayload,
      ),
    ]);

    const concurrentStatuses = concurrentResponses
      .map(({ status }) => status)
      .sort((left, right) => left - right);

    assert.deepEqual(
      concurrentStatuses,
      [200, 200],
      `Concurrent duplicate settlement returned unexpected statuses: ${JSON.stringify(concurrentStatuses)}`,
    );

    const concurrentBodies = await Promise.all(
      concurrentResponses.map((response) => response.json()),
    );

    assert.deepEqual(
      concurrentBodies[1],
      concurrentBodies[0],
      "Concurrent duplicate returns the same durable settlement resource",
    );

    const concurrentEvidence = await eventually(
      () => readReceiptEvidence(pool, concurrentCandidate.receiptId),
      (state) => state?.settlements?.length === 1,
      "concurrent settlement exactly-once persistence",
    );

    assert.equal(
      concurrentEvidence.outbox.filter((row) => row.effectType === "NotifyReceiptSettled").length,
      1,
      "Concurrent duplicate creates one notification outbox work item",
    );

    const deliveryCandidate = seededReceipt("deliveryRetry");
    const deliveryKey = randomUUID();
    deliverySink.failNext();

    const deliverySettlement = resultBody(
      await settlerSdk.receipts.settleReceipt({
        params: { receiptId: deliveryCandidate.receiptId },
        headers: { "idempotency-key": deliveryKey, "if-match": deliveryCandidate.etag },
        payload: settlementAttemptPayload(
          "delivery-retry-reference-0114",
          deliveryCandidate.revision,
        ),
      }),
      "settle delivery-retry receipt through generated SDK",
    );

    assert.equal(
      deliverySettlement.receiptId,
      deliveryCandidate.receiptId,
      "SDK settlement response identifies the receipt",
    );

    const failedDeliveryEvidence = await eventually(
      () => readReceiptEvidence(pool, deliveryCandidate.receiptId),
      (state) =>
        state?.settlements?.length === 1 && state.outbox.some((row) => row.status === "Failed"),
      "failed settlement notification persistence",
    );

    const failedOutbox = failedDeliveryEvidence.outbox.find(
      (row) => row.effectType === "NotifyReceiptSettled",
    );

    assert.deepEqual(
      {
        ordinal: failedOutbox?.ordinal,
        status: failedOutbox?.status,
      },
      {
        ordinal: 0,
        status: "Failed",
      },
      "Failed delivery leaves one durable settlement notification",
    );
    assert.equal(
      failedOutbox?.effectId,
      `${failedOutbox?.commandId}:NotifyReceiptSettled`,
      "Settlement notification identity derives from the durable command identity",
    );
    assert.equal(
      failedDeliveryEvidence.settlements.length,
      1,
      "Delivery failure does not roll back settlement evidence",
    );

    await stopProcess(backendProcess);
    backendProcess = startBackend();
    await waitForHttp(`${backendOrigin}/health`, backendProcess, "Restarted native Effect backend");

    const drain = await runCommand(
      "bun",
      ["run", "--cwd", "apps/backend", "src/receipt/drain-main.ts", deliveryCandidate.receiptId],
      {
        cwd: repositoryRoot,
        env: backendEnvironment,
        label: "Acknowledged receipt settlement notification retry",
        captureOutput: true,
      },
    );

    const drainEvidence = JSON.parse(drain.stdout.trim().split(/\r?\n/u).at(-1));
    assert.equal(
      drainEvidence.result,
      "Complete",
      "Bounded retry acknowledges the settlement notification",
    );

    const recoveredDeliveryEvidence = await eventually(
      () => readReceiptEvidence(pool, deliveryCandidate.receiptId),
      (state) =>
        state?.settlements?.length === 1 && state.outbox.some((row) => row.status === "Delivered"),
      "acknowledged settlement notification retry",
    );

    const recoveredOutbox = recoveredDeliveryEvidence.outbox.find(
      (row) => row.effectType === "NotifyReceiptSettled",
    );

    assert.equal(
      recoveredDeliveryEvidence.settlements.length,
      1,
      "Retry does not create another settlement record",
    );
    assert.equal(
      recoveredOutbox?.effectId,
      failedOutbox?.effectId,
      "Retry keeps the original effect identity",
    );
    assert.ok(recoveredOutbox?.attempts >= 2, "Retry records a second delivery attempt");

    const retryDeliveries = deliverySink.deliveries.filter(
      ({ deliveryId }) => deliveryId === failedOutbox?.effectId,
    );

    assert.deepEqual(
      retryDeliveries.map(({ status }) => status),
      [503, 204],
      "Local receiver observed failure then acknowledged retry for the same effect",
    );
    assert.ok(
      retryDeliveries.every(({ loopback }) => loopback),
      "Delivery retry is confined to loopback",
    );
    assert.ok(
      retryDeliveries.every(({ to }) => to === owner.persona.email),
      "Settlement notification targets the owner",
    );
    assert.ok(
      retryDeliveries.every(
        ({ subject, text }) =>
          Predicate.isString(subject) &&
          subject.length > 0 &&
          Predicate.isString(text) &&
          text.includes("delivery-retry-reference-0114") &&
          text.includes(normalizedAuthority),
      ),
      "Settlement delivery carries the immutable external evidence facts",
    );

    const providerNetworkRecords = {
      configuredPaymentProviders: forbiddenProviderConfiguration,
      browserOrigins: [...new Set(browserRequestOrigins)],
      proxyTargets: [...new Set(proxy.records.map(({ targetOrigin }) => targetOrigin))],
      deliveryTargets: deliverySink.deliveries.map(({ loopback }) => loopback),
      providerCalls: proxy.records.filter(
        ({ method, pathname }) => !isNativeRequest(method, pathname),
      ),
    };

    assert.deepEqual(
      providerNetworkRecords.configuredPaymentProviders,
      [],
      "No provider configuration is present",
    );
    assert.deepEqual(
      providerNetworkRecords.browserOrigins,
      [dashboardOrigin],
      "Chromium only reaches the loopback dashboard",
    );
    assert.deepEqual(
      providerNetworkRecords.proxyTargets,
      [backendOrigin],
      "All dashboard API calls remain on loopback backend",
    );
    assert.ok(
      providerNetworkRecords.deliveryTargets.every(Boolean),
      "All notification traffic is loopback",
    );
    assert.deepEqual(
      providerNetworkRecords.providerCalls,
      [],
      "Settlement journey makes no provider or payment-network call",
    );

    const noCiphertextEvidence = JSON.stringify({
      canonicalRecord,
      canonicalEvidence,
      ownerAfterSettlement,
      queueBeforeSettlement,
      financeSettlementDetail,
      deliveries: deliverySink.deliveries,
      proxyRecords: proxy.records,
    });

    assert.equal(
      noCiphertextEvidence.includes(privatePaymentDestination),
      false,
      "Runtime evidence contains no payment destination ciphertext",
    );

    evidence = {
      topology: {
        dashboard: "production-react-router-server",
        backend: "native-effect-http-api",
        sdk: "generated-@vektorprogrammet/sdk",
        browser: "real-headless-chromium",
        database: "disposable-postgresql-local",
        delivery: "acknowledged-loopback-http",
      },
      seed: {
        fixtureCounts: seed.fixtureCounts,
        departments: seed.departments,
        seededReceiptIds: seed.seededReceiptIds,
      },
      approvalBeforeSettlement: {
        receiptId: submittedReceipt.receiptId,
        status: approvedResult.status,
        revision: approvedResult.revision,
        approvedAt: approvedResult.approvedAt,
        settlementEvidencePresent: false,
      },
      settlement: {
        receipt: canonicalEvidence.receipt,
        evidence: canonicalSettlement,
        audit: canonicalEvidence.audits.filter(({ action }) => action === "ReceiptSettled"),
        outbox: canonicalSettlementOutbox,
      },
      projections: {
        owner: ownerAfterSettlement.settlement,
        finance: financeSettlementDetail,
      },
      denials,
      invalidSources: {
        pending: "receipt.invalid-transition",
        rejected: "receipt.invalid-transition",
        withdrawn: "receipt.invalid-transition",
        alreadySettled: "receipt.already-settled",
        futureSettlement: "settlement.after-recorded-at",
        duplicateExternalReference: "settlement.external-reference-conflict",
      },
      idempotency: {
        replay: "same-response-zero-writes",
        changedReplay: "idempotency.digest-conflict",
        staleRevision: "precondition.failed",
        concurrentStatuses,
        concurrentReplayedCount: concurrentBodies.filter((body) => body?.replayed === true).length,
        concurrentSettlementCount: concurrentEvidence.settlements.length,
      },
      deliveryRecovery: {
        effectId: recoveredOutbox.effectId,
        attempts: recoveredOutbox.attempts,
        settlementCount: recoveredDeliveryEvidence.settlements.length,
        deliveryStatuses: retryDeliveries.map(({ status }) => status),
        restart: true,
      },
      browser: {
        route: settlementRoute,
        mobileWidth: 390,
        keyboard: "open-and-confirm",
        accessibilityViolations: axe.violations.length,
        ownerReloaded: true,
        financeReloaded: true,
      },
      noProviderOrNetworkAction: providerNetworkRecords,
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;

  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }

  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Receipt settlement runtime and cleanup both failed",
    );
  }

  if (primaryError !== undefined) throw primaryError;

  if (cleanupError !== undefined) throw cleanupError;

  if (await pathExists(temporaryRoot)) {
    throw new Error("Receipt settlement runtime left its temporary root behind");
  }

  await Promise.all(disposablePorts.map(assertPortAvailable));
  process.stdout.write(
    `${JSON.stringify({ ...evidence, cleanup: { temporaryRootRemoved: true, postgresRemoved: true } })}\n`,
  );
}

const formatError = (error) => {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map(formatError).join("; ")}`;

  return error instanceof Error ? error.message : String(error);
};

main().catch((error) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
