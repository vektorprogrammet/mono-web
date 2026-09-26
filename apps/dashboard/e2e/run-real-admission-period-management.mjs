import { Predicate } from "effect";
import {
  postgresComposeEnvironment,
  postgresComposeFile,
  postgresProgram,
} from "@monoweb/postgres";
import { deriveHttpIdentity, encodePathIdentity } from "@vektorprogrammet/backend/http-semantics";
import {
  AdmissionsApi,
  CreateAdmissionPeriodEndpoint,
  ReviseAdmissionPeriodEndpoint,
} from "@vektorprogrammet/http-api";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reserveLoopbackPorts } from "../../../tools/e2e/golden-harness.ts";
import { localBackendEnvironment } from "../../../tools/e2e/local-backend-environment.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));

const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));

const [dashboardPort, backendPort, proxyPort, postgresPort] = await reserveLoopbackPorts(4);

const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

const backendOrigin = `http://127.0.0.1:${backendPort}`;

const proxyOrigin = `http://127.0.0.1:${proxyPort}`;

const dashboardMount = "/dashboard/";

const postgresUrl = `postgres://receipt:receipt@127.0.0.1:${postgresPort}/receipt_proof?connect_timeout=1`;

const composeProject = `mono-web-admission-0038-${process.pid}`;

const commandTimeoutMs = 300_000;

const shutdownTimeoutMs = 5_000;

/**
 * ADMISSION_FIXED_NOW pins the authorization instant of admission commands, and a
 * transactional session lookup requires the session to outlive that instant. The pinned
 * instant therefore precedes every session that this journey signs in.
 */
const fixedClock = "2025-09-15T12:00:00.000Z";

/** Reference data that the runner seeds and the spec reads; the spec keeps no copy. */
const reference = {
  fixedNow: fixedClock,
  departmentId: "department-trondheim",
  foreignDepartmentId: "department-bergen",
  semester: {
    id: "semester-autumn-2025",
    startAt: "2025-08-01T00:00:00.000Z",
    endAt: "2025-12-31T00:00:00.000Z",
  },
  fieldOfStudyId: "field-mathematics",
};

const personaPassword = randomBytes(24).toString("base64url");

const betterAuthSecret = randomBytes(32).toString("base64url");

const personas = {
  leader: {
    personId: "person-admission-leader-trondheim",
    firstName: "Tora",
    lastName: "Leder",
    email: "leader.trondheim.admission@example.invalid",
  },
  foreignLeader: {
    personId: "person-admission-leader-bergen",
    firstName: "Berit",
    lastName: "Leder",
    email: "leader.bergen.admission@example.invalid",
  },
  globalAdministrator: {
    personId: "person-admission-global-administrator",
    firstName: "Gunnar",
    lastName: "Administrator",
    email: "global.administrator.admission@example.invalid",
  },
  inactiveLeader: {
    personId: "person-admission-inactive-leader",
    firstName: "Ivar",
    lastName: "Tidligere",
    email: "inactive.leader.admission@example.invalid",
  },
  member: {
    personId: "person-admission-member-trondheim",
    firstName: "Mia",
    lastName: "Medlem",
    email: "member.trondheim.admission@example.invalid",
  },
};

/**
 * Authority comes only from these rows: an active leader of each department's board (Styret),
 * an active global administrator grant, a leader whose only membership has ended, and an
 * active non-leader member. Both departments are independent, so each board leader reaches
 * their own department (O8-11). The admission reference data uses the same departments, and
 * every person has the contact profile that the dashboard shell reads after sign-in.
 */
const seedSql = `
BEGIN;
INSERT INTO person_contact_profiles (person_id, email, phone, revision) VALUES
${Object.values(personas)
  .map(({ personId, email }, index) => `  ('${personId}', '${email}', '+47 900 00 ${40 + index}', 0)`)
  .join(",\n")};
INSERT INTO organization_departments (
  department_id, name, short_name, email, city, active, independent, revision
) VALUES
  ('${reference.departmentId}', 'Vektorprogrammet Trondheim', 'Trondheim',
    'trondheim@example.invalid', 'Trondheim', TRUE, TRUE, 0),
  ('${reference.foreignDepartmentId}', 'Vektorprogrammet Bergen', 'Bergen',
    'bergen@example.invalid', 'Bergen', TRUE, TRUE, 0);
INSERT INTO organization_teams (team_id, department_id, name, kind, active, revision) VALUES
  ('team-admission-trondheim', '${reference.departmentId}', 'Styret Trondheim', 'DepartmentBoard', TRUE, 0),
  ('team-admission-bergen', '${reference.foreignDepartmentId}', 'Styret Bergen', 'DepartmentBoard', TRUE, 0);
INSERT INTO organization_memberships (
  membership_id, person_id, team_id, start_at, end_at, is_team_leader, position_name
) VALUES
  ('membership-admission-leader-trondheim', '${personas.leader.personId}',
    'team-admission-trondheim', '2020-01-01T00:00:00.000Z', NULL, TRUE, 'Leder'),
  ('membership-admission-leader-bergen', '${personas.foreignLeader.personId}',
    'team-admission-bergen', '2020-01-01T00:00:00.000Z', NULL, TRUE, 'Leder'),
  ('membership-admission-inactive-leader', '${personas.inactiveLeader.personId}',
    'team-admission-trondheim', '2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z',
    TRUE, 'Leder'),
  ('membership-admission-member-trondheim', '${personas.member.personId}',
    'team-admission-trondheim', '2020-01-01T00:00:00.000Z', NULL, FALSE, 'Medlem');
INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at, end_at)
VALUES (
  'grant-admission-global-administrator', '${personas.globalAdministrator.personId}',
  '2020-01-01T00:00:00.000Z', NULL
);
INSERT INTO admission_period_departments (department_id, name) VALUES
  ('${reference.departmentId}', 'Trondheim'),
  ('${reference.foreignDepartmentId}', 'Bergen');
INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES
  ('${reference.semester.id}', '${reference.semester.startAt}', '${reference.semester.endAt}');
INSERT INTO admission_period_fields_of_study (
  field_of_study_id, department_id, name, active
) VALUES ('${reference.fieldOfStudyId}', '${reference.departmentId}', 'Matematikk', TRUE);
COMMIT;
`;

const dockerAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

const postgresTopology = dockerAvailable ? "docker" : "local";

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const errorCode = (error) =>
  error !== null && Predicate.isObjectOrArray(error) && "code" in error ? error.code : undefined;

function assertPortAvailable(port) {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      rejectPort(new Error(`Loopback port ${port} is still in use`));
    });
    socket.once("error", (error) => {
      socket.destroy();

      if (errorCode(error) === "ECONNREFUSED") {
        resolvePort();

        return;
      }

      rejectPort(new Error(`Could not inspect loopback port ${port}`));
    });
  });
}

async function waitForPortRelease(port) {
  let lastError;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertPortAvailable(port);

      return;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }

  throw lastError;
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

      const detail = Buffer.concat(stderr).toString("utf8").trim();

      rejectCommand(
        new Error(
          `${options.label} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}${detail.length > 0 ? `: ${detail}` : ""}`,
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
    if (errorCode(error) !== "ESRCH") throw new Error("Could not stop local process group");

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
    if (errorCode(error) !== "ESRCH") throw new Error("Could not terminate local process group");
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
        label: "Disposable admission PostgreSQL readiness check",
        captureOutput: true,
      };

      if (postgresTopology === "docker") await runCommand("docker", args, options);
      else await runCommand(postgresProgram("pg_isready"), args, options);

      return;
    } catch {
      await sleep(250);
    }
  }

  throw new Error("Disposable admission PostgreSQL did not become ready");
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
      label: "Local admission PostgreSQL initialization",
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
      label: "Local admission PostgreSQL startup",
    },
  );
  await waitForPostgres(environment);
  await runCommand(
    postgresProgram("createdb"),
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local admission PostgreSQL database creation",
    },
  );
}

async function stopLocalPostgres(dataRoot, environment) {
  await runCommand(postgresProgram("pg_ctl"), ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    label: "Local admission PostgreSQL cleanup",
  });
}

async function pathExists(path) {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;

    throw error;
  }
}

async function runPsql(sql, environment, label) {
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
    label,
    captureOutput: true,
  };

  return postgresTopology === "docker"
    ? runCommand("docker", args, options)
    : runCommand(postgresProgram("psql"), args, options);
}

const parseJsonBody = (bytes) => {
  if (bytes.byteLength === 0) return null;

  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
};

const admissionPeriodPath = /^\/api\/admission-periods(?:\/|$)/u;

/**
 * The dashboard server calls the backend from its loaders and actions, so the browser's
 * commands are observable only between the two. Each forwarded request is appended to a
 * JSON Lines ledger before its response is released, and the spec reads that ledger.
 * Only admission-period bodies are kept: sign-in bodies carry passwords.
 */
async function startRecordingProxy(ledgerPath) {
  const records = [];

  const record = (entry) => {
    records.push(entry);
    appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
  };

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", backendOrigin);
    const chunks = [];

    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBytes = Buffer.concat(chunks);
    const idempotencyKey = request.headers["idempotency-key"];
    const ifMatch = request.headers["if-match"];

    const entry = {
      method,
      path: url.pathname,
      idempotencyKey: Predicate.isString(idempotencyKey) ? idempotencyKey : null,
      ifMatch: Predicate.isString(ifMatch) ? ifMatch : null,
      body: admissionPeriodPath.test(url.pathname) ? parseJsonBody(requestBytes) : null,
      status: 502,
      problemCode: null,
    };

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

      const upstream = await fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : requestBytes,
        redirect: "manual",
      });

      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      entry.status = upstream.status;

      if (upstream.headers.get("content-type")?.startsWith("application/problem+json") === true) {
        const problem = parseJsonBody(responseBytes);

        entry.problemCode =
          problem !== null &&
          Predicate.isObjectOrArray(problem) &&
          "code" in problem &&
          Predicate.isString(problem.code)
            ? problem.code
            : null;
      }

      record(entry);
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
    } catch {
      record(entry);
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end('{"error":"admission evidence proxy failed"}');
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(proxyPort, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  let closed = false;

  return {
    records,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections?.();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) =>
          error === undefined || errorCode(error) === "ERR_SERVER_NOT_RUNNING"
            ? resolveClose()
            : rejectClose(error),
        );
      });
    },
  };
}

async function readPostgresEvidence(environment) {
  const result = await runPsql(
    `
      SELECT json_build_object(
        'periodCount', (SELECT count(*) FROM admission_periods),
        'commandCount', (SELECT count(*) FROM admission_period_command_receipts),
        'auditCount', (SELECT count(*) FROM admission_period_audit),
        'outboxCount', (SELECT count(*) FROM admission_period_outbox),
        'duplicateEffectCount', (
          SELECT count(*) FROM (
            SELECT effect_id FROM admission_period_outbox
            GROUP BY effect_id HAVING count(*) > 1
          ) duplicate_effects
        ),
        'applicationCount', (SELECT count(*) FROM admission_applications),
        'applicationCommandCount', (
          SELECT count(*) FROM admission_application_command_receipts
        ),
        'period', (
          SELECT json_build_object(
            'id', admission_period_id,
            'departmentId', department_id,
            'semesterId', semester_id,
            'startAt', start_at,
            'endAt', end_at,
            'revision', revision,
            'lastCommandId', last_command_id
          ) FROM admission_periods LIMIT 1
        ),
        'application', (
          SELECT json_build_object(
            'id', application_id,
            'applicantId', applicant_id,
            'admissionPeriodId', admission_period_id
          ) FROM admission_applications LIMIT 1
        ),
        'audits', COALESCE((
          SELECT json_agg(json_build_object(
            'commandId', command_id,
            'admissionPeriodId', admission_period_id,
            'action', action,
            'revision', admission_period_revision
          ) ORDER BY admission_period_revision)
          FROM admission_period_audit
        ), '[]'::json),
        'outbox', COALESCE((
          SELECT json_agg(json_build_object(
            'effectId', effect_id,
            'effectType', effect_type,
            'admissionPeriodId', admission_period_id,
            'commandId', command_id,
            'ordinal', ordinal
          ) ORDER BY command_id, ordinal)
          FROM admission_period_outbox
        ), '[]'::json)
      )::text;
    `,
    environment,
    "Admission persistence evidence query",
  );

  return JSON.parse(result.stdout.trim());
}

/**
 * The backend persists the command ID derived from the credential subject, operation,
 * target, and Idempotency-Key, never the raw key. The leader issued every accepted
 * command: the browser's create and close, and the concurrent API revision that won.
 */
const leaderCommandId = (endpoint, normalizedTarget, idempotencyKey) =>
  deriveHttpIdentity({
    credentialSubject: `Person:${personas.leader.personId}`,
    qualifiedOperationId: `${AdmissionsApi.identifier}.${endpoint.identifier}`,
    normalizedTarget,
    idempotencyKey,
  }).commandId;

function assertDurableEvidence(postgres, lifecycle) {
  const audits = Array.isArray(postgres.audits) ? postgres.audits : [];
  const outbox = Array.isArray(postgres.outbox) ? postgres.outbox : [];

  const periodTarget = ReviseAdmissionPeriodEndpoint.path.replace(
    ":admissionPeriodId",
    encodePathIdentity(lifecycle.period.id),
  );

  const createCommandId = leaderCommandId(
    CreateAdmissionPeriodEndpoint,
    CreateAdmissionPeriodEndpoint.path,
    lifecycle.period.createIdempotencyKey,
  );

  const concurrentWinnerCommandId = leaderCommandId(
    ReviseAdmissionPeriodEndpoint,
    periodTarget,
    lifecycle.period.concurrentWinnerIdempotencyKey,
  );

  const closeCommandId = leaderCommandId(
    ReviseAdmissionPeriodEndpoint,
    periodTarget,
    lifecycle.period.closeIdempotencyKey,
  );

  const acceptedCommandIds = [createCommandId, concurrentWinnerCommandId, closeCommandId];

  const auditCommandIds = audits.map((audit) => audit.commandId);
  const outboxCommandIds = outbox.map((effect) => effect.commandId);

  const expectedActions = [
    "AdmissionPeriodCreated",
    "AdmissionPeriodRevised",
    "AdmissionPeriodRevised",
  ];

  if (
    postgres.periodCount !== 1 ||
    postgres.commandCount !== 3 ||
    postgres.auditCount !== 3 ||
    postgres.outboxCount !== 3 ||
    postgres.duplicateEffectCount !== 0 ||
    postgres.applicationCount !== 1 ||
    postgres.applicationCommandCount !== 1 ||
    postgres.period?.id !== lifecycle.period.id ||
    postgres.period?.revision !== lifecycle.period.finalRevision ||
    postgres.period?.lastCommandId !== closeCommandId ||
    postgres.application?.id !== lifecycle.application.id ||
    postgres.application?.admissionPeriodId !== lifecycle.period.id ||
    lifecycle.publicEligibility.beforeClose.includes(lifecycle.period.id) !== true ||
    lifecycle.publicEligibility.afterClose.includes(lifecycle.period.id) ||
    lifecycle.replay.periodId !== lifecycle.period.id ||
    lifecycle.concurrent.loser.code !== "precondition.failed" ||
    audits.map((audit) => audit.revision).join(",") !== "0,1,2" ||
    audits.map((audit) => audit.action).join(",") !== expectedActions.join(",") ||
    acceptedCommandIds.some((commandId) => !auditCommandIds.includes(commandId)) ||
    acceptedCommandIds.some((commandId) => !outboxCommandIds.includes(commandId)) ||
    outbox.some(
      (effect) => effect.effectType !== "PublishAdmissionPeriodChanged" || effect.ordinal !== 0,
    )
  ) {
    throw new Error("Admission persistence evidence did not prove the frozen journey laws");
  }
}

const describeLedger = (records) =>
  records
    .map(({ method, path, status, problemCode, body }) =>
      [method, path, status, problemCode, body === null ? null : JSON.stringify(body)]
        .filter((part) => part !== null)
        .join(" "),
    )
    .join("\n");

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-admission-0038-"));
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const stagingRoot = join(temporaryRoot, "receipt-staging");
  const committedRoot = join(temporaryRoot, "receipt-committed");
  const lifecycleEvidencePath = join(temporaryRoot, "admission-lifecycle-evidence.json");
  const proxyLedgerPath = join(temporaryRoot, "admission-proxy-ledger.jsonl");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);

  const baseEnvironment = postgresComposeEnvironment({
    ...process.env,
    RECEIPT_APPROVAL_PG_PORT: String(postgresPort),
  });

  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;

  const apiEnvironment = {
    ...baseEnvironment,
    ...localBackendEnvironment({ backendOrigin, dashboardOrigin, postgresUrl, betterAuthSecret }),
    ADMISSION_FIXED_NOW: fixedClock,
    RECEIPT_STAGING_ROOT: stagingRoot,
    RECEIPT_COMMITTED_ROOT: committedRoot,
  };

  const dashboardEnvironment = {
    ...baseEnvironment,
    API_URL: proxyOrigin,
    VITE_API_URL: dashboardOrigin,
    DASHBOARD_ORIGIN: dashboardOrigin,
    DASHBOARD_MOUNT: dashboardMount,
  };

  const playwrightEnvironment = {
    ...dashboardEnvironment,
    REAL_ADMISSION_PERIOD_E2E: "1",
    BACKEND_ORIGIN: backendOrigin,
    ADMISSION_E2E_REFERENCE: JSON.stringify(reference),
    ADMISSION_E2E_PERSONAS: JSON.stringify(
      Object.fromEntries(
        Object.entries(personas).map(([role, { email }]) => [
          role,
          { email, password: personaPassword },
        ]),
      ),
    ),
    ADMISSION_E2E_PROXY_LEDGER_PATH: proxyLedgerPath,
    ADMISSION_E2E_LIFECYCLE_EVIDENCE_PATH: lifecycleEvidencePath,
  };

  let postgresStarted = false;
  let apiProcess;
  let proxy;
  let dashboardProcess;
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

    try {
      await proxy?.close();
    } catch (error) {
      cleanupErrors.push(error);
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
              label: "Disposable admission PostgreSQL cleanup",
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
      throw new AggregateError(cleanupErrors, "Admission topology cleanup failed");
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
        ["compose", "-f", postgresComposeFile, "-p", composeProject, "up", "-d", "receipt-postgres"],
        {
          cwd: repositoryRoot,
          env: baseEnvironment,
          label: "Disposable admission PostgreSQL startup",
        },
      );
      await waitForPostgres(baseEnvironment);
    } else {
      await startLocalPostgres(postgresDataRoot, baseEnvironment);
    }

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
    await runCommand("bun", ["run", "identity:seed"], {
      cwd: databaseRoot,
      env: {
        ...apiEnvironment,
        IDENTITY_SEED_PG_URL: postgresUrl,
        IDENTITY_SEED_PERSONS: JSON.stringify(
          Object.values(personas).map((persona) => ({ ...persona, password: personaPassword })),
        ),
      },
      label: "Admission native identity seed",
      captureOutput: true,
    });
    await runPsql(seedSql, baseEnvironment, "Admission authority and reference-data seed");
    proxy = await startRecordingProxy(proxyLedgerPath);

    await runCommand("bun", ["run", "build"], {
      cwd: dashboardRoot,
      env: dashboardEnvironment,
      label: "Admission dashboard production build",
    });
    dashboardProcess = startProcess("bun", ["server.mjs"], {
      cwd: dashboardRoot,
      env: {
        ...dashboardEnvironment,
        HOST: "127.0.0.1",
        PORT: String(dashboardPort),
        NODE_ENV: "production",
      },
    });
    await waitForHttp(`${dashboardOrigin}${dashboardMount}login`, dashboardProcess, "Dashboard");

    await runCommand(
      process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
      [
        "./node_modules/@playwright/test/cli.js",
        "test",
        "e2e/admission-period-management.spec.ts",
        "--project=admission-period-management",
        "--workers=1",
        "--retries=0",
        "--reporter=list",
      ],
      {
        cwd: dashboardRoot,
        env: playwrightEnvironment,
        label: "Real admission-period Playwright journey",
      },
    );

    const lifecycle = JSON.parse(await readFile(lifecycleEvidencePath, "utf8"));
    const postgres = await readPostgresEvidence(baseEnvironment);
    assertDurableEvidence(postgres, lifecycle);
    evidence = {
      topology: {
        dashboard: "loopback-react-router-production-build",
        api: "unified-native-effect-backend",
        identity: "native-better-auth-sessions",
        database:
          postgresTopology === "docker"
            ? "disposable-postgresql-docker"
            : "disposable-postgresql-local",
        browser: "real-chromium",
        fixedClock,
      },
      postgres,
      lifecycle,
    };
  } catch (error) {
    primaryError = error;

    if (proxy !== undefined && proxy.records.length > 0) {
      process.stderr.write(`Admission proxy ledger:\n${describeLedger(proxy.records)}\n`);
    }
  }

  let cleanupError;

  try {
    await cleanup();

    if (await pathExists(temporaryRoot)) {
      throw new Error("Admission cleanup left the temporary root behind");
    }

    await Promise.all(
      [dashboardPort, backendPort, proxyPort, postgresPort].map((port) => waitForPortRelease(port)),
    );
  } catch (error) {
    cleanupError = error;
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTermination);
  }

  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([primaryError, cleanupError], "Admission journey and cleanup failed");
  }

  if (primaryError !== undefined) throw primaryError;

  if (cleanupError !== undefined) throw cleanupError;

  process.stdout.write(
    `${JSON.stringify({
      ...evidence,
      cleanup: {
        postgresRemoved: true,
        temporaryRootRemoved: true,
        portsReleased: [dashboardPort, backendPort, proxyPort, postgresPort],
      },
    })}\n`,
  );
}

const errorDetail = (error) =>
  error instanceof AggregateError
    ? `${error.message}: ${error.errors.map(errorDetail).join("; ")}`
    : error instanceof Error
      ? error.message
      : String(error);

main().catch((error) => {
  process.stderr.write(`Real admission runner failed: ${errorDetail(error)}\n`);
  process.exitCode = 1;
});
