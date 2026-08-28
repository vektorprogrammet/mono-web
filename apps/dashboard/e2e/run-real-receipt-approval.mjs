import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitNativeRuntimeEvidenceReceipts,
  sanitizePlaywrightArtifact,
} from "./runtime-evidence-receipt.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const composeFile = join(repositoryRoot, "docker-compose.yml");
const dashboardOrigin = "http://127.0.0.1:5174";
const backendOrigin = "http://127.0.0.1:8790";
const postgresUrl = "postgres://receipt:receipt@127.0.0.1:55432/receipt_proof?connect_timeout=1";
const composeProject = `mono-web-receipt-0037-${process.pid}`;
const commandTimeoutMs = 300_000;
const shutdownTimeoutMs = 5_000;
const postgresPort = 55432;
const nixPostgresPackage = "nixpkgs#postgresql_17";
const betterAuthSecret = randomBytes(32).toString("base64url");
const personaPassword = "receipt-approval-0037-password";
const journeyRefId = "intent://journey:parity:finance_operations:v1";
const journeyStepIds = [
  "finance-operations-api-operation",
  "finance-operations-command-write",
  "finance-operations-legacy-route",
  "finance-operations-mono-route",
];
const runnerPath = fileURLToPath(import.meta.url);
const specPath = join(dashboardRoot, "e2e/receipt-approval.spec.ts");
const seedPath = join(dashboardRoot, "e2e/native-receipt-approval-seed.mjs");
const expectedFixtureCounts = {
  identityUsers: 7,
  credentialAccounts: 7,
  personProfiles: 7,
  contactProfiles: 7,
  departments: 2,
  teams: 2,
  organizationMemberships: 7,
  activeMemberships: 6,
  inactiveMemberships: 1,
  organizationGlobalAdministratorGrants: 0,
  paymentAuthorities: 2,
  receiptApprovalGrants: 4,
};
const authorityFixturesByPersonId = new Map([
  ["owner-a", "owner-a-department-a-payment-authority"],
  ["owner-b", "owner-b-department-b-payment-authority"],
  ["approver-a", "approver-a-active-department-a-grant"],
  ["approver-b", "approver-b-active-department-b-grant"],
  ["approver-global", "approver-global-active-global-receipt-grant"],
  ["approver-inactive", "approver-inactive-ended-department-a-membership"],
  ["approver-none", "approver-none-active-without-receipt-grant"],
]);
const dockerAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const postgresTopology = dockerAvailable ? "docker" : "local";

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
      if (error && typeof error === "object" && "code" in error && error.code === "ECONNREFUSED") {
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
      if (code === 0) {
        resolveCommand(
          captureOutput ? { stdout: Buffer.concat(stdout).toString("utf8") } : undefined,
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

function runNixPostgres(command, args, options) {
  return runCommand("nix", ["shell", nixPostgresPackage, "--command", command, ...args], options);
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) {
    return;
  }

  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
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
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
      throw new Error("Could not terminate local process group");
    }
  }
  await exited;
}

async function waitForHttp(url, child, label) {
  const deadline = Date.now() + commandTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before readiness`);
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // Readiness is retried until the bounded deadline.
    }
    await sleep(250);
  }
  throw new Error(`${label} did not become ready`);
}

async function waitForPostgres(environment) {
  const deadline = Date.now() + commandTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const args =
        postgresTopology === "docker"
          ? [
              "compose",
              "-f",
              composeFile,
              "-p",
              composeProject,
              "exec",
              "-T",
              "receipt-postgres",
              "pg_isready",
              "-U",
              "receipt",
              "-d",
              "receipt_proof",
            ]
          : ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "-d", "receipt_proof"];
      const options = {
        cwd: repositoryRoot,
        env: environment,
        label: "Disposable PostgreSQL readiness check",
        captureOutput: true,
      };
      if (postgresTopology === "docker") await runCommand("docker", args, options);
      else await runNixPostgres("pg_isready", args, options);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready");
}

async function startLocalPostgres(dataRoot, environment) {
  await rm(dataRoot, { recursive: true, force: true });
  await mkdir(dataRoot, { recursive: true });
  await runNixPostgres(
    "initdb",
    [
      "--pgdata",
      dataRoot,
      "--username=receipt",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-locale",
      "--encoding=UTF8",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local disposable PostgreSQL initialization",
    },
  );
  await runNixPostgres(
    "pg_ctl",
    [
      "-D",
      dataRoot,
      "-o",
      `-p ${postgresPort} -h 127.0.0.1 -k ${dataRoot}`,
      "-l",
      join(dataRoot, "postgres.log"),
      "-w",
      "start",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local disposable PostgreSQL startup",
    },
  );
  await waitForPostgres(environment);
  await runNixPostgres(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local disposable PostgreSQL database creation",
    },
  );
}

async function stopLocalPostgres(dataRoot, environment) {
  await runNixPostgres("pg_ctl", ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    label: "Local disposable PostgreSQL cleanup",
  });
}

async function countFiles(root) {
  try {
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    return entries.reduce((count, entry) => count + (entry.isFile() ? 1 : 0), 0);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

const parseJsonBody = (bytes) => {
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
};

const sanitizeRequestBody = (bytes, contentType, pathname) => {
  if (bytes.byteLength === 0) return null;
  if (contentType.startsWith("multipart/form-data")) {
    return { kind: "multipart/form-data" };
  }
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    return {
      kind: "form",
      keys: [...new URLSearchParams(bytes.toString("utf8")).keys()].sort(),
    };
  }
  if (contentType.startsWith("application/json")) {
    const decoded = parseJsonBody(bytes);
    if (decoded === undefined) return { kind: "malformed-json" };
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      return { kind: "json", shape: typeof decoded };
    }
    const keys = Object.keys(decoded).sort();
    if (
      /\/api\/admin\/receipts\/[^/]+\/(?:refund|reject)$/u.test(pathname) &&
      JSON.stringify(keys) === JSON.stringify(["commandId", "expectedRevision"]) &&
      typeof decoded.commandId === "string" &&
      Number.isInteger(decoded.expectedRevision)
    ) {
      return { commandId: decoded.commandId, expectedRevision: decoded.expectedRevision };
    }
    return { kind: "json", keys };
  }
  return { kind: "opaque", byteLength: bytes.byteLength };
};

const sessionCookieNames = new Set([
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
]);

const sessionCookieKey = (cookieHeader) => {
  if (typeof cookieHeader !== "string") return undefined;
  const pairs = cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      const separator = pair.indexOf("=");
      return separator > 0 && sessionCookieNames.has(pair.slice(0, separator).trim());
    })
    .sort();
  return pairs.length === 0 ? undefined : pairs.join("; ");
};

const setCookieKey = (setCookie) => {
  const pair = setCookie.split(";", 1)[0]?.trim();
  if (pair === undefined) return undefined;
  const separator = pair.indexOf("=");
  return separator > 0 && sessionCookieNames.has(pair.slice(0, separator).trim())
    ? pair
    : undefined;
};

async function startRecordingProxy(targetOrigin) {
  const records = [];
  const sessionPersonsByCookie = new Map();
  const issuedSessionCookieNamesByCookie = new Map();
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", targetOrigin);
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBytes = Buffer.concat(chunks);
    const cookieKey = sessionCookieKey(request.headers.cookie);
    const record = {
      method,
      pathname: url.pathname,
      query: url.search,
      status: 0,
      body: sanitizeRequestBody(
        requestBytes,
        typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : "",
        url.pathname,
      ),
      sessionCookieAuth: cookieKey !== undefined,
      authorizationHeaderPresent: request.headers.authorization !== undefined,
      sessionPersonId:
        cookieKey === undefined ? null : (sessionPersonsByCookie.get(cookieKey) ?? null),
      canonicalAuthorityFixture: null,
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
      const upstream = await fetch(new URL(request.url ?? "/", targetOrigin), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : requestBytes,
        redirect: "manual",
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      const responseJson = parseJsonBody(responseBytes);
      record.status = upstream.status;
      if (
        cookieKey !== undefined &&
        upstream.status === 200 &&
        url.pathname === "/api/me/session" &&
        responseJson !== null &&
        typeof responseJson === "object" &&
        "personId" in responseJson &&
        typeof responseJson.personId === "string"
      ) {
        sessionPersonsByCookie.set(cookieKey, responseJson.personId);
        record.sessionPersonId = responseJson.personId;
      }
      if (record.sessionPersonId !== null) {
        record.canonicalAuthorityFixture =
          authorityFixturesByPersonId.get(record.sessionPersonId) ?? null;
      }
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers.entries()) {
        if (
          ["content-encoding", "content-length", "set-cookie", "transfer-encoding"].includes(name)
        ) {
          continue;
        }
        response.setHeader(name, value);
      }
      const setCookies = upstream.headers.getSetCookie();
      for (const setCookie of setCookies) {
        const issuedCookieKey = setCookieKey(setCookie);
        if (issuedCookieKey === undefined) continue;
        issuedSessionCookieNamesByCookie.set(issuedCookieKey, [
          issuedCookieKey.slice(0, issuedCookieKey.indexOf("=")),
        ]);
      }
      if (setCookies.length > 0) response.setHeader("set-cookie", setCookies);
      response.setHeader("content-length", String(responseBytes.byteLength));
      response.end(responseBytes);
    } catch {
      record.status = 502;
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end('{"error":"native Receipt evidence proxy failed"}');
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
    throw new Error("Native Receipt evidence proxy did not bind a loopback port");
  }
  let closed = false;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    records,
    sessionCookieEvidence: () =>
      [...sessionPersonsByCookie.entries()]
        .map(([cookieKey, personId]) => ({
          personId,
          sessionCookieNames: issuedSessionCookieNamesByCookie.get(cookieKey) ?? [],
        }))
        .sort(({ personId: left }, { personId: right }) => left.localeCompare(right)),
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) =>
          error === undefined ||
          (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ERR_SERVER_NOT_RUNNING")
            ? resolveClose()
            : rejectClose(error),
        );
      });
    },
  };
}

const assertEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not match the frozen amendment`);
  }
};

async function readPostgresEvidence(environment) {
  const sql = `
    SELECT json_build_object(
      'receiptCount', (SELECT count(*) FROM economy_receipts),
      'commandCount', (SELECT count(*) FROM economy_receipt_command_receipts),
      'auditCount', (SELECT count(*) FROM economy_receipt_audit),
      'outboxCount', (SELECT count(*) FROM economy_receipt_outbox),
      'deliveredOutboxCount', (
        SELECT count(*) FROM economy_receipt_outbox WHERE status = 'Delivered'
      ),
      'pendingOutboxCount', (
        SELECT count(*) FROM economy_receipt_outbox WHERE status <> 'Delivered'
      ),
      'duplicateEffectCount', (
        SELECT count(*) FROM (
          SELECT command_id, ordinal
          FROM economy_receipt_outbox
          GROUP BY command_id, ordinal
          HAVING count(*) > 1
        ) duplicate_effects
      ),
      'fixtureCounts', json_build_object(
        'identityUsers', (SELECT count(*)::int FROM auth."user"),
        'credentialAccounts', (
          SELECT count(*)::int FROM auth.account WHERE "providerId" = 'credential'
        ),
        'personProfiles', (SELECT count(*)::int FROM person_profiles),
        'contactProfiles', (SELECT count(*)::int FROM person_contact_profiles),
        'departments', (SELECT count(*)::int FROM organization_departments),
        'teams', (SELECT count(*)::int FROM organization_teams),
        'organizationMemberships', (SELECT count(*)::int FROM organization_memberships),
        'activeMemberships', (
          SELECT count(*)::int
          FROM organization_memberships
          WHERE start_at <= now() AND (end_at IS NULL OR end_at > now()) AND NOT is_suspended
        ),
        'inactiveMemberships', (
          SELECT count(*)::int
          FROM organization_memberships
          WHERE end_at <= now() OR is_suspended
        ),
        'organizationGlobalAdministratorGrants', (
          SELECT count(*)::int FROM organization_global_administrator_grants
        ),
        'paymentAuthorities', (SELECT count(*)::int FROM economy_payment_authorities),
        'receiptApprovalGrants', (SELECT count(*)::int FROM economy_receipt_approval_grants)
      ),
      'receipts', (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'receiptId', receipt_id,
              'visualId', visual_id,
              'ownerPersonId', owner_person_id,
              'departmentId', department_id,
              'status', status,
              'revision', revision,
              'refundDate', CASE WHEN refund_date IS NULL THEN NULL
                ELSE to_char(refund_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              END,
              'fileRef', file_ref,
              'objectKey', file_object_key,
              'sha256', file_sha256
            )
            ORDER BY receipt_id
          ),
          '[]'::json
        )
        FROM economy_receipts
      ),
      'commands', (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'commandId', command_id,
              'receiptId', receipt_id
            )
            ORDER BY committed_at, command_id
          ),
          '[]'::json
        )
        FROM economy_receipt_command_receipts
      ),
      'audits', (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'commandId', command_id,
              'receiptId', receipt_id,
              'actorPersonId', actor_person_id,
              'action', action,
              'receiptRevision', receipt_revision
            )
            ORDER BY command_id
          ),
          '[]'::json
        )
        FROM economy_receipt_audit
      ),
      'outbox', (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'effectId', outbox.effect_id,
              'effectType', outbox.effect_type,
              'receiptId', outbox.receipt_id,
              'commandId', outbox.command_id,
              'ordinal', outbox.ordinal,
              'status', outbox.status
            )
            ORDER BY command_receipt.committed_at, outbox.command_id, outbox.ordinal
          ),
          '[]'::json
        )
        FROM economy_receipt_outbox AS outbox
        JOIN economy_receipt_command_receipts AS command_receipt
          ON command_receipt.command_id = outbox.command_id
      )
    )::text;
  `;
  const args =
    postgresTopology === "docker"
      ? [
          "compose",
          "-f",
          composeFile,
          "-p",
          composeProject,
          "exec",
          "-T",
          "receipt-postgres",
          "psql",
          "-U",
          "receipt",
          "-d",
          "receipt_proof",
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          sql,
        ]
      : [
          "-h",
          "127.0.0.1",
          "-p",
          String(postgresPort),
          "-U",
          "receipt",
          "-d",
          "receipt_proof",
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          sql,
        ];
  const options = {
    cwd: repositoryRoot,
    env: environment,
    label: "Receipt persistence evidence query",
    captureOutput: true,
  };
  const result =
    postgresTopology === "docker"
      ? await runCommand("docker", args, options)
      : await runNixPostgres("psql", args, options);
  return JSON.parse(result.stdout.trim());
}

function assertExpectedOutboxCommandOrder(postgres, journeyEvidence) {
  const expectedCommandOrder = [
    ...journeyEvidence.commands.submissions,
    journeyEvidence.commands.refund,
    journeyEvidence.commands.reject,
    journeyEvidence.commands.stale,
    journeyEvidence.commands.concurrentWinner,
  ];
  const observedCommandOrder = [];
  for (const row of postgres.outbox) {
    if (observedCommandOrder.at(-1) !== row.commandId) {
      observedCommandOrder.push(row.commandId);
    }
  }
  if (JSON.stringify(observedCommandOrder) !== JSON.stringify(expectedCommandOrder)) {
    throw new Error("Receipt approval outbox effects are not ordered by accepted command");
  }
}

function assertDurableEvidence(postgres, privateFile, journeyEvidence) {
  assertExpectedOutboxCommandOrder(postgres, journeyEvidence);
  if (
    postgres.receiptCount !== 4 ||
    postgres.commandCount !== 8 ||
    postgres.auditCount !== 8 ||
    postgres.outboxCount !== 20 ||
    postgres.deliveredOutboxCount !== 20 ||
    postgres.pendingOutboxCount !== 0 ||
    postgres.duplicateEffectCount !== 0
  ) {
    throw new Error("Receipt approval persistence counts did not prove exactly-once effects");
  }
  assertEqual(postgres.fixtureCounts, expectedFixtureCounts, "Receipt authority fixture counts");

  if (
    privateFile.stagingFileCount !== 0 ||
    privateFile.committedFileCount !== 4 ||
    JSON.stringify(journeyEvidence.fileIdentitiesBefore) !==
      JSON.stringify(journeyEvidence.fileIdentitiesAfter)
  ) {
    throw new Error("Receipt approval private-file identities changed during resolution");
  }
  const finalFileIdentities = postgres.receipts.map((receipt) => ({
    receiptId: receipt.receiptId,
    fileRef: receipt.fileRef,
    objectKey: receipt.objectKey,
    sha256: receipt.sha256,
  }));
  if (JSON.stringify(finalFileIdentities) !== JSON.stringify(journeyEvidence.fileIdentitiesAfter)) {
    throw new Error("Receipt approval durable file identities differ from journey evidence");
  }

  if (
    journeyEvidence.durablePostgresFailure?.status !== 503 ||
    journeyEvidence.durablePostgresFailure?.tag !== "ReceiptPersistenceError"
  ) {
    throw new Error("Receipt approval journey did not prove a typed PostgreSQL failure");
  }

  const expectedReceiptIds = Object.values(journeyEvidence.receipts);
  const receiptById = new Map(postgres.receipts.map((receipt) => [receipt.receiptId, receipt]));
  if (
    expectedReceiptIds.length !== 4 ||
    new Set(expectedReceiptIds).size !== 4 ||
    postgres.receipts.length !== expectedReceiptIds.length
  ) {
    throw new Error("Receipt approval durable receipt identity set is incomplete");
  }

  for (const receiptId of expectedReceiptIds) {
    const receipt = receiptById.get(receiptId);
    if (receipt === undefined || receipt.revision !== 1) {
      throw new Error(`Receipt ${receiptId} did not commit exactly one approval revision`);
    }
    if (
      (receipt.status === "Refunded" && typeof receipt.refundDate !== "string") ||
      (receipt.status !== "Refunded" && receipt.refundDate !== null)
    ) {
      throw new Error(`Receipt ${receiptId} violated the refund-date invariant`);
    }
  }

  const expectedCommandIds = [
    ...journeyEvidence.commands.submissions,
    journeyEvidence.commands.refund,
    journeyEvidence.commands.reject,
    journeyEvidence.commands.stale,
    journeyEvidence.commands.concurrentWinner,
  ];
  if (new Set(expectedCommandIds).size !== 8) {
    throw new Error("Receipt approval command IDs are not unique");
  }
  const commandIds = postgres.commands.map((command) => command.commandId);
  if (
    commandIds.length !== expectedCommandIds.length ||
    !expectedCommandIds.every((commandId) => commandIds.includes(commandId))
  ) {
    throw new Error("Rejected approval commands created durable command receipts");
  }

  const auditByCommand = new Map(postgres.audits.map((audit) => [audit.commandId, audit]));
  if (
    postgres.audits.some((audit) => !expectedCommandIds.includes(audit.commandId)) ||
    expectedCommandIds.some((commandId) => auditByCommand.get(commandId) === undefined)
  ) {
    throw new Error("Receipt approval audit rows do not match accepted commands");
  }
  const submissionActors = new Map(
    journeyEvidence.commands.submissionActors.map(({ commandId, personId }) => [
      commandId,
      personId,
    ]),
  );
  for (const commandId of journeyEvidence.commands.submissions) {
    const audit = auditByCommand.get(commandId);
    if (
      audit?.action !== "ReceiptSubmitted" ||
      audit.actorPersonId !== submissionActors.get(commandId)
    ) {
      throw new Error("Receipt submission audit actor or action is incorrect");
    }
  }
  if (auditByCommand.get(journeyEvidence.commands.refund)?.action !== "ReceiptRefunded") {
    throw new Error("Receipt refund audit action is incorrect");
  }
  if (
    auditByCommand.get(journeyEvidence.commands.reject)?.action !== "ReceiptRejected" ||
    auditByCommand.get(journeyEvidence.commands.stale)?.action !== "ReceiptRejected"
  ) {
    throw new Error("Receipt rejection audit action is incorrect");
  }
  const concurrentReceipt = receiptById.get(journeyEvidence.receipts.concurrent);
  const expectedConcurrentAction =
    concurrentReceipt?.status === "Refunded" ? "ReceiptRefunded" : "ReceiptRejected";
  if (
    auditByCommand.get(journeyEvidence.commands.concurrentWinner)?.action !==
    expectedConcurrentAction
  ) {
    throw new Error("Concurrent approval audit action is incorrect");
  }
  for (const commandId of [
    journeyEvidence.commands.refund,
    journeyEvidence.commands.reject,
    journeyEvidence.commands.stale,
    journeyEvidence.commands.concurrentWinner,
  ]) {
    if (
      auditByCommand.get(commandId)?.actorPersonId !==
      journeyEvidence.commands.resolutionActorPersonId
    ) {
      throw new Error("Receipt resolution audit actor is not the Global approver");
    }
  }

  const outboxByCommand = new Map();
  for (const row of postgres.outbox) {
    const rows = outboxByCommand.get(row.commandId) ?? [];
    rows.push(row);
    outboxByCommand.set(row.commandId, rows);
    if (row.status !== "Delivered")
      throw new Error("Receipt approval outbox is not fully delivered");
  }
  const expectedSubmissionEffects = [
    "PromoteReceiptFile",
    "NotifyEconomyReceiptSubmitted",
    "WriteReceiptAudit",
  ];
  for (const commandId of journeyEvidence.commands.submissions) {
    const rows = outboxByCommand
      .get(commandId)
      ?.sort((left, right) => left.ordinal - right.ordinal);
    if (
      rows === undefined ||
      rows.length !== expectedSubmissionEffects.length ||
      rows.some(
        (row, ordinal) =>
          row.ordinal !== ordinal || row.effectType !== expectedSubmissionEffects[ordinal],
      )
    ) {
      throw new Error("Receipt submission outbox order is incorrect");
    }
  }
  const expectedResolutionEffects = new Map([
    [journeyEvidence.commands.refund, "NotifyReceiptRefunded"],
    [journeyEvidence.commands.reject, "NotifyReceiptRejected"],
    [journeyEvidence.commands.stale, "NotifyReceiptRejected"],
    [
      journeyEvidence.commands.concurrentWinner,
      expectedConcurrentAction === "ReceiptRefunded"
        ? "NotifyReceiptRefunded"
        : "NotifyReceiptRejected",
    ],
  ]);
  for (const [commandId, notificationEffect] of expectedResolutionEffects) {
    const rows = outboxByCommand
      .get(commandId)
      ?.sort((left, right) => left.ordinal - right.ordinal);
    if (
      rows === undefined ||
      rows.length !== 2 ||
      rows[0]?.ordinal !== 0 ||
      rows[0]?.effectType !== notificationEffect ||
      rows[1]?.ordinal !== 1 ||
      rows[1]?.effectType !== "WriteReceiptAudit"
    ) {
      throw new Error("Receipt approval outbox order is incorrect");
    }
  }
}

function assertJourneyEvidence(journeyEvidence, seedEvidence) {
  assertEqual(journeyEvidence.journeyRefId, journeyRefId, "Finance journey reference");
  assertEqual(journeyEvidence.acceptedStepIds, journeyStepIds, "Finance journey steps");
  if (journeyEvidence.environmentTokenAuthority !== false) {
    throw new Error("Receipt journey evidence did not exclude environment-token authority");
  }
  const expectedSessions = [...seedEvidence.personas]
    .map(({ fixtureLabel, personId }) => ({
      fixtureLabel,
      nativeLogin: true,
      sessionCookieNames: ["better-auth.session_token"],
      apiSessionPath: "/api/me/session",
      personId,
    }))
    .sort(({ personId: left }, { personId: right }) => left.localeCompare(right));
  const observedSessions = Object.values(journeyEvidence.sessions).sort(
    ({ personId: left }, { personId: right }) => left.localeCompare(right),
  );
  assertEqual(observedSessions, expectedSessions, "Seven rendered Better Auth sessions");
  assertEqual(
    journeyEvidence.statusMatrix,
    {
      approvalList: {
        missingSession: 401,
        invalidSession: 401,
        inactiveActor: 403,
        noScopeActor: 403,
        departmentA: 200,
        departmentB: 200,
        global: 200,
        forcedPostgresFailure: 503,
        recoveredAfterPostgresFailure: 200,
      },
      command: {
        inactiveActor: 403,
        malformedJson: 422,
        excessJson: 422,
        queryParameters: 422,
        foreignDepartment: 403,
        absentDepartmentScope: 403,
        absentGlobalScope: 404,
        acceptedRefund: 200,
        acceptedReject: 200,
        identicalRefundReplay: 200,
        identicalRejectReplay: 200,
        changedReplay: 409,
        staleRevision: 409,
        terminalRefund: 409,
        terminalReject: 409,
        concurrent: [200, 409],
      },
    },
    "Frozen Receipt approval status matrix",
  );
  assertEqual(
    journeyEvidence.rendered.forbiddenBrowserRequests,
    [],
    "Forbidden browser request ledger",
  );
}

function assertRequestLedger(records, journeyEvidence) {
  if (records.some(({ authorizationHeaderPresent }) => authorizationHeaderPresent)) {
    throw new Error("Native Receipt transport used an Authorization header");
  }
  const serialized = JSON.stringify(records);
  for (const forbiddenValue of [
    personaPassword,
    "ciphertext-owner-a-0037",
    "ciphertext-owner-b-0037",
  ]) {
    if (serialized.includes(forbiddenValue)) {
      throw new Error("Native Receipt ledger retained a credential or private authority value");
    }
  }
  const forbiddenRequests = records.filter(
    ({ method, pathname }) =>
      pathname === "/api/login" ||
      pathname.startsWith("/api/fixtures") ||
      /\/api\/admin\/receipts\/[^/]+\/status$/u.test(pathname) ||
      (["PUT", "PATCH", "DELETE"].includes(method) && pathname.includes("/receipts")),
  );
  assertEqual(forbiddenRequests, [], "Forbidden native Receipt requests");

  const receiptOperations = records.filter(
    ({ pathname }) =>
      pathname.startsWith("/api/receipts") || pathname.startsWith("/api/admin/receipts"),
  );
  for (const record of receiptOperations) {
    if (record.authorizationHeaderPresent) {
      throw new Error("Protected Receipt request used Authorization");
    }
    if (!record.sessionCookieAuth) {
      if (record.status !== 401) {
        throw new Error("Only an explicit unauthenticated Receipt probe omitted its session");
      }
      continue;
    }
    if (record.status !== 401) {
      if (
        record.sessionPersonId === null ||
        record.canonicalAuthorityFixture !== authorityFixturesByPersonId.get(record.sessionPersonId)
      ) {
        throw new Error("Receipt request did not resolve canonical person-keyed authority");
      }
    }
  }

  const submissions = receiptOperations.filter(
    ({ method, pathname }) => method === "POST" && pathname === "/api/receipts/submit",
  );
  if (
    submissions.length !== 4 ||
    submissions.some(
      ({ status, body }) => ![200, 201].includes(status) || body?.kind !== "multipart/form-data",
    )
  ) {
    throw new Error("Receipt submission sequence is not the exact four native multipart writes");
  }
  const ownerReads = receiptOperations.filter(
    ({ method, pathname }) => method === "GET" && pathname === "/api/receipts",
  );
  if (ownerReads.length !== 4 || ownerReads.some(({ status }) => status !== 200)) {
    throw new Error("Receipt owner read sequence is not exact");
  }

  const semanticPath = /\/api\/admin\/receipts\/[^/]+\/(?:refund|reject)$/u;
  const commands = receiptOperations.filter(
    ({ method, pathname }) => method === "POST" && semanticPath.test(pathname),
  );
  const commandStatuses = commands.map(({ status }) => status).sort((left, right) => left - right);
  assertEqual(
    commandStatuses,
    [
      200, 200, 200, 200, 200, 200, 200, 403, 403, 403, 403, 404, 409, 409, 409, 409, 409, 409, 422,
      422, 422,
    ],
    "Exact scoped refund/reject operation sequence",
  );
  for (const command of commands) {
    if (command.status === 422) continue;
    if (
      command.body === null ||
      typeof command.body.commandId !== "string" ||
      !Number.isInteger(command.body.expectedRevision) ||
      JSON.stringify(Object.keys(command.body).sort()) !==
        JSON.stringify(["commandId", "expectedRevision"])
    ) {
      throw new Error("Semantic Receipt command body was not exact");
    }
  }
  for (let index = 0; index < receiptOperations.length; index += 1) {
    const operation = receiptOperations[index];
    if (
      operation?.method !== "POST" ||
      operation.status !== 200 ||
      !semanticPath.test(operation.pathname)
    ) {
      continue;
    }
    let freshRead = receiptOperations[index + 1];
    if (
      freshRead?.method === "POST" &&
      semanticPath.test(freshRead.pathname) &&
      freshRead.pathname.split("/").at(-2) === operation.pathname.split("/").at(-2)
    ) {
      freshRead = receiptOperations[index + 2];
    }
    if (
      freshRead?.method !== "GET" ||
      freshRead.pathname !== "/api/admin/receipts" ||
      freshRead.status !== 200
    ) {
      throw new Error("Accepted Receipt command was not followed by a fresh approval-list read");
    }
  }
  assertEqual(
    journeyEvidence.rendered.loginPersonIds.slice().sort(),
    [...authorityFixturesByPersonId.keys()].sort(),
    "Rendered login PersonIds",
  );
  return receiptOperations;
}

async function main() {
  await Promise.all([
    assertPortAvailable(5174),
    assertPortAvailable(8790),
    assertPortAvailable(55432),
  ]);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-receipt-approval-0037-"));
  const stagingRoot = join(temporaryRoot, "staging");
  const committedRoot = join(temporaryRoot, "committed");
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const approvalEvidencePath = join(temporaryRoot, "approval-evidence.json");
  const externalPlaywrightConfigPath = join(temporaryRoot, "playwright.external.config.mjs");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);
  await writeFile(
    externalPlaywrightConfigPath,
    `import base from ${JSON.stringify(join(dashboardRoot, "playwright.config.ts"))};
export default {
  ...base,
  testDir: ${JSON.stringify(join(dashboardRoot, "e2e"))},
  outputDir: ${JSON.stringify(join(dashboardRoot, "e2e/results"))},
  snapshotDir: ${JSON.stringify(join(dashboardRoot, "e2e/snapshots"))},
  webServer: undefined,
};
`,
    "utf8",
  );

  const baseEnvironment = { ...process.env };
  for (const name of [
    "API_MODE",
    "VITE_API_MODE",
    "ALCHEMY_CLOUDFLARE_VITE_INJECTED",
    "ADMISSION_AUTH_TOKENS",
    "ORGANIZATION_AUTH_TOKENS",
    "RECEIPT_AUTH_TOKENS",
    "RECEIPT_E2E_TOKEN",
    "RECEIPT_E2E_FOREIGN_TOKEN",
    "RECEIPT_APPROVAL_E2E_OWNER_A_TOKEN",
    "RECEIPT_APPROVAL_E2E_OWNER_B_TOKEN",
    "RECEIPT_APPROVAL_E2E_DEPARTMENT_A_TOKEN",
    "RECEIPT_APPROVAL_E2E_DEPARTMENT_B_TOKEN",
    "RECEIPT_APPROVAL_E2E_GLOBAL_TOKEN",
    "RECEIPT_APPROVAL_E2E_INACTIVE_TOKEN",
    "RECEIPT_APPROVAL_E2E_NONE_SCOPE_TOKEN",
  ]) {
    delete baseEnvironment[name];
  }
  const sharedEnvironment = {
    ...baseEnvironment,
    BETTER_AUTH_SECRET: betterAuthSecret,
    BETTER_AUTH_URL: dashboardOrigin,
  };
  const apiEnvironment = {
    ...sharedEnvironment,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: "8790",
    BACKEND_PG_URL: postgresUrl,
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    RECEIPT_STAGING_ROOT: stagingRoot,
    RECEIPT_COMMITTED_ROOT: committedRoot,
    RECEIPT_MAX_FILE_BYTES: "10485760",
    RECEIPT_E2E_TEST_MODE: "1",
  };

  let postgresStarted = false;
  let apiProcess;
  let dashboardProcess;
  let proxy;
  let evidence;
  let playwrightArtifactBytes;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const cleanupErrors = [];
    try {
      await stopProcess(dashboardProcess);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (proxy !== undefined) {
      try {
        await proxy.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await stopProcess(apiProcess);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (postgresStarted) {
      try {
        if (postgresTopology === "docker") {
          await runCommand(
            "docker",
            [
              "compose",
              "-f",
              composeFile,
              "-p",
              composeProject,
              "down",
              "--volumes",
              "--remove-orphans",
            ],
            {
              cwd: repositoryRoot,
              env: baseEnvironment,
              label: "Disposable PostgreSQL cleanup",
            },
          );
        } else if (await pathExists(join(postgresDataRoot, "postmaster.pid"))) {
          await stopLocalPostgres(postgresDataRoot, baseEnvironment);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Real Receipt approval topology cleanup failed");
    }
  };

  const handleSignal = (signal) => {
    void cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  const handleInterrupt = () => handleSignal("SIGINT");
  const handleTermination = () => handleSignal("SIGTERM");
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);

  let primaryError;
  try {
    postgresStarted = true;
    if (postgresTopology === "docker") {
      await runCommand(
        "docker",
        ["compose", "-f", composeFile, "-p", composeProject, "up", "-d", "receipt-postgres"],
        {
          cwd: repositoryRoot,
          env: baseEnvironment,
          label: "Disposable PostgreSQL startup",
        },
      );
      await waitForPostgres(baseEnvironment);
    } else {
      await startLocalPostgres(postgresDataRoot, baseEnvironment);
    }

    const seed = await runCommand(process.execPath, [seedPath], {
      cwd: repositoryRoot,
      env: {
        ...sharedEnvironment,
        RECEIPT_APPROVAL_PG_URL: postgresUrl,
      },
      label: "Native Receipt identity and authority seed",
      captureOutput: true,
    });
    const seedEvidence = JSON.parse(seed.stdout.trim().split(/\r?\n/u).at(-1));
    assertEqual(seedEvidence.fixtureCounts, expectedFixtureCounts, "Seeded authority counts");

    const configuredBackendCommand = process.env.BACKEND_COMMAND;
    apiProcess = configuredBackendCommand
      ? startProcess("/bin/sh", ["-c", configuredBackendCommand], {
          cwd: repositoryRoot,
          env: apiEnvironment,
        })
      : startProcess("bun", ["run", "--cwd", "apps/backend", "start"], {
          cwd: repositoryRoot,
          env: apiEnvironment,
        });
    await waitForHttp(`${backendOrigin}/health`, apiProcess, "Unified native backend");
    proxy = await startRecordingProxy(backendOrigin);

    const personaByPersonId = new Map(
      seedEvidence.personas.map((persona) => [persona.personId, persona]),
    );
    const journeyEnvironment = {
      ...sharedEnvironment,
      API_URL: proxy.origin,
      VITE_API_URL: proxy.origin,
      VITE_DASHBOARD_ORIGIN: dashboardOrigin,
      BACKEND_ORIGIN: proxy.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      HOST: "127.0.0.1",
      PORT: "5174",
      REAL_NATIVE_CONDUCT_E2E: "1",
      REAL_RECEIPT_OWNER_E2E: "1",
      REAL_RECEIPT_APPROVAL_E2E: "1",
      RECEIPT_COMPOSE_FILE: composeFile,
      RECEIPT_COMPOSE_PROJECT: composeProject,
      RECEIPT_POSTGRES_TOPOLOGY: postgresTopology,
      RECEIPT_POSTGRES_PACKAGE: nixPostgresPackage,
      RECEIPT_PG_DATA_ROOT: postgresDataRoot,
      RECEIPT_PG_PORT: String(postgresPort),
      RECEIPT_APPROVAL_EVIDENCE_FILE: approvalEvidencePath,
      BACKEND_PG_URL: postgresUrl,
    };
    for (const [prefix, personId] of [
      ["RECEIPT_APPROVAL_E2E_OWNER_A", "owner-a"],
      ["RECEIPT_APPROVAL_E2E_OWNER_B", "owner-b"],
      ["RECEIPT_APPROVAL_E2E_DEPARTMENT_A", "approver-a"],
      ["RECEIPT_APPROVAL_E2E_DEPARTMENT_B", "approver-b"],
      ["RECEIPT_APPROVAL_E2E_GLOBAL", "approver-global"],
      ["RECEIPT_APPROVAL_E2E_INACTIVE", "approver-inactive"],
      ["RECEIPT_APPROVAL_E2E_NONE_SCOPE", "approver-none"],
    ]) {
      const persona = personaByPersonId.get(personId);
      if (persona === undefined) throw new Error(`Receipt persona ${personId} was not seeded`);
      journeyEnvironment[`${prefix}_EMAIL`] = persona.email;
      journeyEnvironment[`${prefix}_PASSWORD`] = personaPassword;
      journeyEnvironment[`${prefix}_PERSON_ID`] = persona.personId;
    }
    await runCommand("bun", ["run", "build"], {
      cwd: dashboardRoot,
      env: journeyEnvironment,
      label: "Native Receipt dashboard build",
    });
    dashboardProcess = startProcess("bun", ["run", "start"], {
      cwd: dashboardRoot,
      env: journeyEnvironment,
    });
    await waitForHttp(`${dashboardOrigin}/login`, dashboardProcess, "Dashboard");

    const playwright = await runCommand(
      "nix",
      [
        "shell",
        "nixpkgs#nodejs_24",
        "--command",
        "node",
        "./node_modules/@playwright/test/cli.js",
        "test",
        "e2e/receipt-approval.spec.ts",
        `--config=${externalPlaywrightConfigPath}`,
        "--project=receipt-owner",
        "--workers=1",
        "--retries=0",
        "--reporter=json",
      ],
      {
        cwd: dashboardRoot,
        env: journeyEnvironment,
        label: "Real Receipt approval Playwright journey",
        captureOutput: true,
      },
    );
    playwrightArtifactBytes = sanitizePlaywrightArtifact(Buffer.from(playwright.stdout, "utf8"));

    const journeyEvidence = JSON.parse(await readFile(approvalEvidencePath, "utf8"));
    assertJourneyEvidence(journeyEvidence, seedEvidence);
    const expectedSessionCookies = [...authorityFixturesByPersonId.keys()]
      .map((personId) => ({
        personId,
        sessionCookieNames: ["better-auth.session_token"],
      }))
      .sort(({ personId: left }, { personId: right }) => left.localeCompare(right));
    assertEqual(
      proxy.sessionCookieEvidence(),
      expectedSessionCookies,
      "Exactly one Better Auth session cookie per persona",
    );
    const receiptOperations = assertRequestLedger(proxy.records, journeyEvidence);
    const postgres = await readPostgresEvidence(baseEnvironment);
    const privateFile = {
      stagingFileCount: await countFiles(stagingRoot),
      committedFileCount: await countFiles(committedRoot),
    };
    assertDurableEvidence(postgres, privateFile, journeyEvidence);
    evidence = {
      topology: {
        dashboard: "loopback-react-router",
        api: "unified-native-effect-backend",
        proxy: "loopback-sanitized-recording-proxy",
        database:
          postgresTopology === "docker"
            ? "disposable-postgresql-docker"
            : "disposable-postgresql-local-nix",
        privateFile: "disposable-filesystem",
        symfonyProcessesStarted: 0,
        fixtureApiProcessesStarted: 0,
      },
      journeyRefId,
      acceptedStepIds: journeyStepIds,
      seed: seedEvidence,
      postgres,
      privateFile,
      journey: journeyEvidence,
      requestLedger: proxy.records,
      receiptOperationCount: receiptOperations.length,
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
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTermination);
  }

  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Real Receipt approval journey and cleanup failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  if (await pathExists(temporaryRoot)) {
    throw new Error("Real Receipt approval cleanup left the private temporary root behind");
  }
  if (playwrightArtifactBytes === undefined) {
    throw new Error("Receipt approval JSON reporter artifact was not captured");
  }

  await emitNativeRuntimeEvidenceReceipts({
    repositoryRoot,
    sourcePaths: [runnerPath, specPath, seedPath],
    journeys: [{ journeyRefId, stepIds: journeyStepIds }],
    fixtureId: "native-receipt-approval-0037",
    fixtureInputBytes: await readFile(seedPath),
    artifactBytes: playwrightArtifactBytes,
  });

  process.stdout.write(
    `${JSON.stringify({
      ...evidence,
      cleanup: {
        postgresRemoved: true,
        privateFilesystemRemoved: true,
        temporaryRootRemoved: true,
      },
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Real Receipt approval runner failed"}\n`,
  );
  process.exitCode = 1;
});
