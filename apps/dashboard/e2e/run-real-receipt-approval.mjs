import {
  postgresComposeEnvironment,
  postgresComposeFile,
  postgresProgram,
} from "@monoweb/postgres";
import { Predicate, Match } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { startReceiptDeliverySink } from "../../../tools/e2e/receipt-delivery-sink.ts";
import { sanitizePlaywrightArtifact } from "./runtime-evidence-receipt.mjs";
import { addressesAnyRoute, addressesRoute, legacyRoutes } from "./request-routes.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Resolves each named port from the environment, or reserves a distinct
 * ephemeral loopback port for it: every reservation binds port 0 and stays
 * bound until all are read, so the kernel cannot hand one port out twice.
 */
const configuredPorts = async (names) => {
  const servers = [];

  try {
    const ports = [];

    for (const name of names) {
      const configured = process.env[name];

      if (configured === undefined) {
        const server = await new Promise((resolveServer, rejectServer) => {
          const listening = createNetServer();
          listening.once("error", rejectServer);
          listening.listen(0, "127.0.0.1", () => resolveServer(listening));
        });

        servers.push(server);
        const address = server.address();

        if (address === null || Predicate.isString(address)) {
          throw new Error(`${name} reservation did not bind a TCP port`);
        }

        ports.push(address.port);
        continue;
      }

      const port = Number(configured);

      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`${name} must be a TCP port`);
      }

      ports.push(port);
    }

    return ports;
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))),
    );
  }
};

const [dashboardPort, backendPort, postgresPort] = await configuredPorts([
  "RECEIPT_APPROVAL_DASHBOARD_PORT",
  "RECEIPT_APPROVAL_BACKEND_PORT",
  "RECEIPT_APPROVAL_PG_PORT",
]);

const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

const backendOrigin = `http://127.0.0.1:${backendPort}`;

const postgresUrl = `postgres://receipt:receipt@127.0.0.1:${postgresPort}/receipt_proof?connect_timeout=1`;

const composeProject = `mono-web-receipt-0037-${process.pid}`;

const commandTimeoutMs = 300_000;

const shutdownTimeoutMs = 5_000;

const betterAuthSecret = randomBytes(32).toString("base64url");

const personaPassword = "receipt-approval-0037-password";

const receiptDeliverySender = "economy@example.invalid";

const receiptEconomyRecipients = Object.freeze({
  "department-a": "economy-a@example.invalid",
  "department-b": "economy-b@example.invalid",
});

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

      if (error && (error === null || Predicate.isObjectOrArray(error)) && "code" in error && error.code === "ECONNREFUSED") {
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

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) {
    return;
  }

  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (!error || !(error === null || Predicate.isObjectOrArray(error)) || !("code" in error) || error.code !== "ESRCH") {
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
    if (!error || !(error === null || Predicate.isObjectOrArray(error)) || !("code" in error) || error.code !== "ESRCH") {
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
              postgresComposeFile,
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
      else await runCommand(postgresProgram("pg_isready"), args, options);

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
  await runCommand(
    postgresProgram("initdb"),
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
  await runCommand(
    postgresProgram("pg_ctl"),
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
  await runCommand(
    postgresProgram("createdb"),
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local disposable PostgreSQL database creation",
    },
  );
}

async function stopLocalPostgres(dataRoot, environment) {
  await runCommand(postgresProgram("pg_ctl"), ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    label: "Local disposable PostgreSQL cleanup",
  });
}

/**
 * Counts receipt files under root. The file store keeps one durable effect
 * reservation marker per promotion under `.effects`; those are not receipt files.
 */
async function countFiles(root) {
  try {
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });

    return entries.reduce(
      (count, entry) =>
        count +
        (entry.isFile() && relative(root, entry.parentPath).split(sep)[0] !== ".effects" ? 1 : 0),
      0,
    );
  } catch (error) {
    if (error && (error === null || Predicate.isObjectOrArray(error)) && "code" in error && error.code === "ENOENT") {
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
    if (error && (error === null || Predicate.isObjectOrArray(error)) && "code" in error && error.code === "ENOENT") {
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

const sanitizeRequestBody = (bytes, contentType) => {
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

    if (decoded === null || !Predicate.isObjectOrArray(decoded) || Array.isArray(decoded)) {
      return { kind: "json", jsonValueType: Match.value(decoded).pipe(Match.when(Predicate.isString, () => "string"), Match.when(Predicate.isNumber, () => "number"), Match.when(Predicate.isBoolean, () => "boolean"), Match.orElse(() => "object")) };
    }

    const keys = Object.keys(decoded).sort();

    return { kind: "json", keys };
  }

  return { kind: "opaque", byteLength: bytes.byteLength };
};

const sessionCookieNames = new Set([
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
]);

const sessionCookieKey = (cookieHeader) => {
  if (!Predicate.isString(cookieHeader)) return undefined;

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
        Predicate.isString(request.headers["content-type"]) ? request.headers["content-type"] : "",
      ),
      sessionCookieAuth: cookieKey !== undefined,
      authorizationHeaderPresent: request.headers.authorization !== undefined,
      sessionPersonId:
        cookieKey === undefined ? null : (sessionPersonsByCookie.get(cookieKey) ?? null),
      canonicalAuthorityFixture: null,
      idempotencyKey:
        Predicate.isString(request.headers["idempotency-key"])
          ? request.headers["idempotency-key"]
          : null,
      ifMatch: Predicate.isString(request.headers["if-match"]) ? request.headers["if-match"] : null,
      concurrencyProbe:
        Predicate.isString(request.headers["x-receipt-e2e-concurrency-probe"])
          ? request.headers["x-receipt-e2e-concurrency-probe"]
          : null,
      concurrencySynchronized: null,
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
      record.concurrencySynchronized = upstream.headers.get(
        "x-receipt-e2e-concurrency-synchronized",
      );

      if (
        cookieKey !== undefined &&
        upstream.status === 200 &&
        url.pathname === "/api/session" &&
        responseJson !== null &&
        Predicate.isObjectOrArray(responseJson) &&
        "personId" in responseJson &&
        Predicate.isString(responseJson.personId)
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

  if (address === null || Predicate.isString(address)) {
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
          (Predicate.isObjectOrArray(error) &&
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
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `${label} did not match the frozen amendment: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
    );
  }
};

const fileIdentityChecksum = (identities) =>
  `sha256:${createHash("sha256").update(JSON.stringify(identities)).digest("hex")}`;

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
              'approvedAt', CASE WHEN approved_at IS NULL THEN NULL
                ELSE to_char(approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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
          postgresComposeFile,
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
      : await runCommand(postgresProgram("psql"), args, options);

  return JSON.parse(result.stdout.trim());
}

function assertExpectedOutboxCommandOrder(postgres, journeyEvidence) {
  const expectedCommandOrder = [
    ...journeyEvidence.commands.submissions,
    journeyEvidence.commands.approval,
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
    throw new Error(
      `Receipt approval outbox effects are not ordered by accepted command: observed=${JSON.stringify(observedCommandOrder)} expected=${JSON.stringify(expectedCommandOrder)}`,
    );
  }
}

function assertReceiptFileArtifact(artifact, contentType) {
  const extensionByContentType = {
    "application/pdf": "pdf",
    "image/png": "png",
  };

  const extension = extensionByContentType[contentType];

  if (
    artifact === null ||
    !Predicate.isObjectOrArray(artifact) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    artifact.contentType !== contentType ||
    artifact.contentDisposition !== `inline; filename="receipt.${extension}"` ||
    !Predicate.isString(artifact.sha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.sha256)
  ) {
    throw new Error("Receipt approval file artifact did not preserve the private file contract");
  }
}

function assertFileReadEvidence(fileReads) {
  if (fileReads === null || !Predicate.isObjectOrArray(fileReads)) {
    throw new Error("Receipt approval file-read evidence is missing");
  }

  const { artifacts, mutationCounts, rejected } = fileReads;

  if (
    artifacts === null ||
    !Predicate.isObjectOrArray(artifacts) ||
    mutationCounts === null ||
    !Predicate.isObjectOrArray(mutationCounts)
  ) {
    throw new Error("Receipt approval file-read evidence is malformed");
  }

  for (const name of [
    "activePng",
    "dashboardPng",
    "terminalApproved",
    "dashboardTerminalApproved",
    "concurrent",
  ]) {
    assertReceiptFileArtifact(artifacts[name], "image/png");
  }

  for (const name of ["activePdf", "dashboardPdf", "terminalReject", "dashboardTerminalReject"]) {
    assertReceiptFileArtifact(artifacts[name], "application/pdf");
  }

  assertEqual(
    artifacts.dashboardPng,
    artifacts.activePng,
    "Dashboard PNG receipt file bytes and headers",
  );
  assertEqual(
    artifacts.dashboardPdf,
    artifacts.activePdf,
    "Dashboard PDF receipt file bytes and headers",
  );
  assertEqual(
    artifacts.terminalApproved,
    artifacts.activePng,
    "Approved Receipt file bytes and headers",
  );
  assertEqual(
    artifacts.dashboardTerminalApproved,
    artifacts.activePng,
    "Dashboard approved Receipt file bytes and headers",
  );
  assertEqual(
    artifacts.terminalReject,
    artifacts.activePdf,
    "Rejected Receipt file bytes and headers",
  );
  assertEqual(
    artifacts.dashboardTerminalReject,
    artifacts.activePdf,
    "Dashboard rejected Receipt file bytes and headers",
  );
  assertEqual(
    artifacts.concurrent,
    artifacts.activePng,
    "Concurrent Receipt file bytes and headers",
  );
  assertEqual(
    rejected,
    {
      missingSession: "credential.missing",
      invalidSession: "credential.invalid",
      ownerApproval: "authority.denied",
      foreignOwner: "resource.not-found",
      approverOwner: "resource.not-found",
      foreignScope: "authority.denied",
      inactive: "authority.denied",
      noScope: "authority.denied",
      absent: "resource.not-found",
      missingObject: "receipts.unavailable",
    },
    "Receipt file read rejection codes",
  );
  assertEqual(
    mutationCounts.fileOnlyAfter,
    mutationCounts.fileOnlyBefore,
    "Direct Receipt file reads left database mutation counts unchanged",
  );
  assertEqual(
    mutationCounts.browserAfter,
    mutationCounts.browserBefore,
    "Dashboard Receipt file reads left database mutation counts unchanged",
  );
  assertEqual(
    mutationCounts.terminalAfter,
    mutationCounts.terminalBefore,
    "Terminal Receipt file reads left database mutation counts unchanged",
  );
  assertEqual(
    mutationCounts.concurrentAfter,
    {
      receiptCount: mutationCounts.concurrentBefore.receiptCount,
      commandCount: mutationCounts.concurrentBefore.commandCount + 1,
      auditCount: mutationCounts.concurrentBefore.auditCount + 1,
      outboxCount: mutationCounts.concurrentBefore.outboxCount + 2,
    },
    "Concurrent Receipt file read and decision mutation counts",
  );
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
    throw new Error(
      `Receipt approval persistence counts did not prove exactly-once effects: ${JSON.stringify({
        receiptCount: postgres.receiptCount,
        commandCount: postgres.commandCount,
        auditCount: postgres.auditCount,
        outboxCount: postgres.outboxCount,
        deliveredOutboxCount: postgres.deliveredOutboxCount,
        pendingOutboxCount: postgres.pendingOutboxCount,
        duplicateEffectCount: postgres.duplicateEffectCount,
      })}`,
    );
  }

  assertEqual(postgres.fixtureCounts, expectedFixtureCounts, "Receipt authority fixture counts");

  if (privateFile.stagingFileCount !== 0 || privateFile.committedFileCount !== 4) {
    throw new Error(
      `Receipt approval private-file cleanup did not preserve the committed files: staging=${privateFile.stagingFileCount} committed=${privateFile.committedFileCount}`,
    );
  }

  const finalFileIdentities = postgres.receipts.map((receipt) => ({
    receiptId: receipt.receiptId,
    fileRef: receipt.fileRef,
    objectKey: receipt.objectKey,
    sha256: receipt.sha256,
  }));

  const finalFileIdentityChecksum = fileIdentityChecksum(finalFileIdentities);

  if (
    journeyEvidence.fileIdentityCount !== finalFileIdentities.length ||
    journeyEvidence.fileIdentityChecksumBefore !== finalFileIdentityChecksum ||
    journeyEvidence.fileIdentityChecksumAfter !== finalFileIdentityChecksum
  ) {
    throw new Error("Receipt approval durable file identities differ from journey evidence");
  }

  assertFileReadEvidence(journeyEvidence.fileReads);

  if (
    journeyEvidence.durablePostgresFailure?.status !== 503 ||
    journeyEvidence.durablePostgresFailure?.tag !== "receipts.unavailable"
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
      (receipt.status === "Approved" && !Predicate.isString(receipt.approvedAt)) ||
      (receipt.status !== "Approved" && receipt.approvedAt !== null)
    ) {
      throw new Error(`Receipt ${receiptId} violated the approved-at invariant`);
    }
  }

  const expectedCommandIds = [
    ...journeyEvidence.commands.submissions,
    journeyEvidence.commands.approval,
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

  if (auditByCommand.get(journeyEvidence.commands.approval)?.action !== "ReceiptApproved") {
    throw new Error("Receipt approval audit action is incorrect");
  }

  if (
    auditByCommand.get(journeyEvidence.commands.reject)?.action !== "ReceiptRejected" ||
    auditByCommand.get(journeyEvidence.commands.stale)?.action !== "ReceiptRejected"
  ) {
    throw new Error("Receipt rejection audit action is incorrect");
  }

  const concurrentReceipt = receiptById.get(journeyEvidence.receipts.concurrent);

  const expectedConcurrentAction =
    concurrentReceipt?.status === "Approved" ? "ReceiptApproved" : "ReceiptRejected";

  if (
    auditByCommand.get(journeyEvidence.commands.concurrentWinner)?.action !==
    expectedConcurrentAction
  ) {
    throw new Error("Concurrent approval audit action is incorrect");
  }

  for (const commandId of [
    journeyEvidence.commands.approval,
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
    [journeyEvidence.commands.approval, "NotifyReceiptApproved"],
    [journeyEvidence.commands.reject, "NotifyReceiptRejected"],
    [journeyEvidence.commands.stale, "NotifyReceiptRejected"],
    [
      journeyEvidence.commands.concurrentWinner,
      expectedConcurrentAction === "ReceiptApproved"
        ? "NotifyReceiptApproved"
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

function assertReceiptDeliveryEvidence(postgres, deliveries, seedEvidence) {
  const notificationRows = postgres.outbox.filter((row) => row.effectType.startsWith("Notify"));
  const deliveryById = new Map(deliveries.map((delivery) => [delivery.deliveryId, delivery]));

  if (
    notificationRows.length !== 8 ||
    deliveries.length !== notificationRows.length ||
    deliveryById.size !== deliveries.length
  ) {
    throw new Error("Receipt notification delivery count did not match durable outbox effects");
  }

  const receiptById = new Map(postgres.receipts.map((receipt) => [receipt.receiptId, receipt]));

  const emailByPersonId = new Map(
    seedEvidence.personas.map((persona) => [persona.personId, persona.email]),
  );

  const subjectByEffectType = {
    NotifyEconomyReceiptSubmitted: "Nytt utlegg registrert",
    NotifyReceiptApproved: "Utlegget ditt er godkjent",
    NotifyReceiptRejected: "Utlegget ditt er avvist",
  };

  for (const row of notificationRows) {
    const delivery = deliveryById.get(row.effectId);
    const receipt = receiptById.get(row.receiptId);
    const subject = subjectByEffectType[row.effectType];

    const expectedRecipient =
      row.effectType === "NotifyEconomyReceiptSubmitted"
        ? receiptEconomyRecipients[receipt?.departmentId]
        : emailByPersonId.get(receipt?.ownerPersonId);

    if (
      delivery === undefined ||
      receipt === undefined ||
      subject === undefined ||
      expectedRecipient === undefined ||
      delivery.from !== receiptDeliverySender ||
      delivery.to !== expectedRecipient ||
      delivery.subject !== subject ||
      !Predicate.isString(delivery.text) ||
      !delivery.text.includes(receipt.visualId)
    ) {
      throw new Error(`Receipt notification delivery ${row.effectId} is not authoritative`);
    }
  }
}

function assertJourneyEvidence(journeyEvidence, seedEvidence) {
  if (journeyEvidence.environmentTokenAuthority !== false) {
    throw new Error("Receipt journey evidence did not exclude environment-token authority");
  }

  const expectedSessions = [...seedEvidence.personas]
    .map(({ fixtureLabel, personId }) => ({
      fixtureLabel,
      nativeLogin: true,
      sessionCookieNames: ["better-auth.session_token"],
      apiSessionPath: "/api/session",
      personBindingPath: "/api/profile",
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
        malformedJson: 400,
        excessJson: 422,
        queryParameters: 400,
        foreignDepartment: 403,
        absentDepartmentScope: 404,
        absentGlobalScope: 404,
        acceptedApproval: 200,
        acceptedReject: 200,
        identicalApprovalReplay: 200,
        identicalRejectReplay: 200,
        changedReplay: 409,
        staleRevision: 412,
        terminalApproved: 409,
        terminalReject: 409,
        concurrent: [200, 412],
      },
      approvalFile: {
        missingSession: 401,
        invalidSession: 401,
        activePng: 200,
        activePdf: 200,
        ownerEndpoint: 200,
        ownerApproval: 403,
        foreignOwner: 404,
        approverOwner: 404,
        foreignScope: 403,
        inactive: 403,
        noScope: 403,
        absent: 404,
        missingObject: 503,
        terminalApproved: 200,
        terminalReject: 200,
        concurrent: 200,
        dashboard: {
          missingSession: 401,
          invalidSession: 401,
          activePng: 200,
          activePdf: 200,
          foreignScope: 403,
          absent: 404,
          unavailable: 503,
          terminalApproved: 200,
          terminalReject: 200,
        },
      },
    },
    "Frozen Receipt approval status matrix",
  );

  if (journeyEvidence.accepted.concurrent.transactionBarrierSynchronized !== true) {
    throw new Error("Receipt transaction concurrency barrier evidence is missing");
  }

  assertEqual(
    journeyEvidence.rendered.forbiddenBrowserRequests,
    [],
    "Forbidden browser request ledger",
  );
  assertEqual(
    journeyEvidence.rendered.receiptFileLink,
    {
      desktopNoOverflow: true,
      mobileNoOverflow: true,
      keyboardActivated: true,
      opensSeparateTab: true,
      rel: "noopener noreferrer",
    },
    "Rendered Receipt file link accessibility",
  );
  assertEqual(
    journeyEvidence.rendered.sameOriginReceiptFileRequests,
    [
      {
        method: "GET",
        origin: dashboardOrigin,
        pathname: `/dashboard/utlegg/${journeyEvidence.receipts.approval}/file`,
        query: "",
      },
      {
        method: "GET",
        origin: dashboardOrigin,
        pathname: `/dashboard/utlegg/${journeyEvidence.receipts.reject}/file`,
        query: "",
      },
    ],
    "Same-origin Receipt file resource navigations",
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
      addressesAnyRoute(pathname, legacyRoutes) ||
      (["PUT", "PATCH", "DELETE"].includes(method) && addressesRoute(pathname, "/api/receipts")),
  );

  assertEqual(forbiddenRequests, [], "Forbidden native Receipt requests");

  const receiptOperations = records.filter(
    ({ pathname }) =>
      pathname.startsWith("/api/receipts") || pathname.startsWith("/api/receipt-approval-queue"),
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
    ({ method, pathname }) => method === "POST" && pathname === "/api/receipts",
  );

  if (
    submissions.length !== 4 ||
    submissions.some(
      ({ status, body, idempotencyKey, ifMatch }) =>
        status !== 201 ||
        body?.kind !== "multipart/form-data" ||
        !Predicate.isString(idempotencyKey) ||
        ifMatch !== null,
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

  const ownerFilePath = /^\/api\/receipts\/[^/]+\/file$/u;

  const ownerFileReads = receiptOperations.filter(
    ({ method, pathname }) => method === "GET" && ownerFilePath.test(pathname),
  );

  assertEqual(
    ownerFileReads.map(({ status }) => status).sort((left, right) => left - right),
    [200, 404, 404],
    "Owner Receipt file access remains separate from approval access",
  );
  const approvalFilePath = /^\/api\/receipt-approval-queue\/[^/]+\/file$/u;

  const approvalFileReads = receiptOperations.filter(
    ({ method, pathname }) => method === "GET" && approvalFilePath.test(pathname),
  );

  assertEqual(
    approvalFileReads.map(({ status }) => status).sort((left, right) => left - right),
    [
      200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 401, 401, 403, 403, 403, 403, 403, 404,
      404, 503, 503,
    ],
    "Exact scoped Receipt file read operation sequence",
  );

  if (
    approvalFileReads.some(
      ({ body, idempotencyKey, ifMatch }) =>
        body !== null || idempotencyKey !== null || ifMatch !== null,
    )
  ) {
    throw new Error("Receipt file reads carried mutation request state");
  }

  const concurrencyRecords = receiptOperations
    .filter(({ concurrencyProbe }) => concurrencyProbe !== null)
    .sort(({ concurrencyProbe: left }, { concurrencyProbe: right }) => left.localeCompare(right));

  if (
    concurrencyRecords.length !== 3 ||
    concurrencyRecords.some(({ concurrencySynchronized }) => concurrencySynchronized !== "1")
  ) {
    throw new Error("Receipt transaction concurrency barrier was not observed on all three lanes");
  }

  assertEqual(
    concurrencyRecords.map(({ concurrencyProbe }) => concurrencyProbe),
    ["approve", "file-read", "reject"],
    "Receipt transaction concurrency barrier lanes",
  );
  assertEqual(
    concurrencyRecords.map(({ status }) => status).sort((left, right) => left - right),
    [200, 200, 412],
    "Receipt transaction concurrency barrier outcomes",
  );

  const semanticPath = /\/api\/receipts\/[^/:]+:(?:approve|reject)$/u;

  const commands = receiptOperations.filter(
    ({ method, pathname }) => method === "POST" && semanticPath.test(pathname),
  );

  const commandStatuses = commands.map(({ status }) => status).sort((left, right) => left - right);
  assertEqual(
    commandStatuses,
    [
      200, 200, 200, 200, 200, 200, 200, 400, 400, 403, 403, 403, 404, 404, 409, 409, 409, 412, 412,
      412, 422,
    ],
    "Exact scoped approval/reject operation sequence",
  );

  for (const command of commands) {
    if (!Predicate.isString(command.idempotencyKey) || !Predicate.isString(command.ifMatch)) {
      throw new Error("Semantic Receipt command omitted Idempotency-Key or If-Match");
    }

    if (command.body?.kind === "malformed-json") continue;

    if (
      command.body?.kind !== "json" ||
      !Array.isArray(command.body.keys) ||
      (command.status !== 422 && command.body.keys.length !== 0)
    ) {
      throw new Error("Semantic Receipt command body was not the canonical empty JSON object");
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

    let freshReadIndex = index + 1;

    while (freshReadIndex < receiptOperations.length) {
      const candidate = receiptOperations[freshReadIndex];

      if (
        candidate?.method === "GET" &&
        candidate.pathname === "/api/receipt-approval-queue" &&
        candidate.status === 200
      ) {
        break;
      }

      if (
        (candidate?.method === "GET" && approvalFilePath.test(candidate.pathname)) ||
        (candidate?.method === "POST" &&
          semanticPath.test(candidate.pathname) &&
          candidate.pathname.split(":")[0] === operation.pathname.split(":")[0])
      ) {
        freshReadIndex += 1;
        continue;
      }

      throw new Error("Accepted Receipt command was not followed by a fresh approval-list read");
    }

    if (freshReadIndex === receiptOperations.length) {
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
    assertPortAvailable(dashboardPort),
    assertPortAvailable(backendPort),
    assertPortAvailable(postgresPort),
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

  const baseEnvironment = postgresComposeEnvironment({
    ...process.env,
    RECEIPT_APPROVAL_PG_PORT: String(postgresPort),
  });

  for (const name of [
    "API_MODE",
    "VITE_API_MODE",
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
    "RECEIPT_DELIVERY_URL",
    "RECEIPT_DELIVERY_TOKEN",
    "RECEIPT_DELIVERY_TIMEOUT_MS",
    "RECEIPT_DELIVERY_SENDER",
    "RECEIPT_DELIVERY_ECONOMY_RECIPIENTS",
  ]) {
    delete baseEnvironment[name];
  }

  const sharedEnvironment = {
    ...baseEnvironment,
    BETTER_AUTH_SECRET: betterAuthSecret,
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
  };

  const apiEnvironment = {
    ...sharedEnvironment,
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

  let postgresStarted = false;
  let apiProcess;
  let dashboardProcess;
  let proxy;
  let deliverySink;
  let evidence;
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

    if (deliverySink !== undefined) {
      try {
        await deliverySink.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (postgresStarted) {
      try {
        if (postgresTopology === "docker") {
          await runCommand(
            "docker",
            [
              "compose",
              "-f",
              postgresComposeFile,
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
        [
          "compose",
          "-f",
          postgresComposeFile,
          "-p",
          composeProject,
          "up",
          "-d",
          "receipt-postgres",
        ],
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
    deliverySink = await startReceiptDeliverySink({
      sender: receiptDeliverySender,
      economyRecipients: receiptEconomyRecipients,
    });

    const runtimeApiEnvironment = {
      ...apiEnvironment,
      ...deliverySink.environment,
    };

    const configuredBackendCommand = process.env.BACKEND_COMMAND;
    apiProcess = configuredBackendCommand
      ? startProcess("/bin/sh", ["-c", configuredBackendCommand], {
          cwd: repositoryRoot,
          env: runtimeApiEnvironment,
        })
      : startProcess("bun", ["run", "--cwd", "apps/backend", "start"], {
          cwd: repositoryRoot,
          env: runtimeApiEnvironment,
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
      PORT: String(dashboardPort),
      REAL_NATIVE_CONDUCT_E2E: "1",
      REAL_RECEIPT_OWNER_E2E: "1",
      REAL_RECEIPT_APPROVAL_E2E: "1",
      RECEIPT_COMPOSE_PROJECT: composeProject,
      RECEIPT_POSTGRES_TOPOLOGY: postgresTopology,
      RECEIPT_PG_DATA_ROOT: postgresDataRoot,
      RECEIPT_PG_PORT: String(postgresPort),
      RECEIPT_APPROVAL_EVIDENCE_FILE: approvalEvidencePath,
      RECEIPT_COMMITTED_ROOT: committedRoot,
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
      "node",
      [
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

    sanitizePlaywrightArtifact(Buffer.from(playwright.stdout, "utf8"));

    const journeyEvidence = JSON.parse(await readFile(approvalEvidencePath, "utf8"));
    assertJourneyEvidence(journeyEvidence, seedEvidence);

    const expectedSessionCookies = [...authorityFixturesByPersonId.keys()]
      .map((personId) => ({
        personId,
        sessionCookieNames: ["better-auth.session_token"],
      }))
      .sort(({ personId: left }, { personId: right }) => left.localeCompare(right));

    const observedSessionCookies = proxy.sessionCookieEvidence();

    if (JSON.stringify(observedSessionCookies) !== JSON.stringify(expectedSessionCookies)) {
      throw new Error(
        `Exactly one Better Auth session cookie per persona did not match the frozen amendment: observed=${JSON.stringify(observedSessionCookies)} expected=${JSON.stringify(expectedSessionCookies)}`,
      );
    }

    const receiptOperations = assertRequestLedger(proxy.records, journeyEvidence);
    const postgres = await readPostgresEvidence(baseEnvironment);

    const privateFile = {
      stagingFileCount: await countFiles(stagingRoot),
      committedFileCount: await countFiles(committedRoot),
    };

    assertDurableEvidence(postgres, privateFile, journeyEvidence);

    if (deliverySink === undefined) {
      throw new Error("Receipt delivery sink was not started");
    }

    const receiptDeliveries = deliverySink.evidence();
    assertReceiptDeliveryEvidence(postgres, receiptDeliveries, seedEvidence);
    evidence = {
      topology: {
        dashboard: "loopback-react-router",
        api: "unified-native-effect-backend",
        proxy: "loopback-sanitized-recording-proxy",
        database:
          postgresTopology === "docker"
            ? "disposable-postgresql-docker"
            : "disposable-postgresql-local",
        privateFile: "disposable-filesystem",
        delivery: "acknowledged-loopback-http-sink",
        symfonyProcessesStarted: 0,
        fixtureApiProcessesStarted: 0,
      },
      seed: seedEvidence,
      postgres,
      privateFile,
      receiptDeliveries,
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

const formatRunnerError = (error) => {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(formatRunnerError).join("; ")}`;
  }

  return error instanceof Error ? error.message : String(error);
};

main().catch((error) => {
  process.stderr.write(`${formatRunnerError(error)}\n`);
  process.exitCode = 1;
});
