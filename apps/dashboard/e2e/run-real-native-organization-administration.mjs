import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitRuntimeEvidenceReceipt,
  sanitizePlaywrightArtifact,
} from "./runtime-evidence-receipt.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));
const composeFile = join(repositoryRoot, "docker-compose.yml");
const dashboardPort = 5185;
const backendPort = 8797;
const postgresPort = 55432;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const postgresUrl = `postgres://receipt:receipt@127.0.0.1:${postgresPort}/receipt_proof?connect_timeout=1`;
const composeProject = `mono-web-native-organization-0052-${process.pid}`;
const commandTimeoutMs = 300_000;
const shutdownTimeoutMs = 5_000;
const nixPostgresPackage = "nixpkgs#postgresql_17";
const adminPersonId = "person-organization-administrator-0052";
const memberPersonId = "person-organization-member-0052";
const fixtureDepartmentId = "department-organization-member-0052";
const fixtureTeamId = "team-organization-member-0052";
const adminEmail = "administrator.organization.0052@example.invalid";
const memberEmail = "member.organization.0052@example.invalid";
const personaPassword = "native-organization-0052-password-0123456789";
const betterAuthSecret = randomBytes(32).toString("base64url");
const identitySeedPersons = [
  {
    personId: adminPersonId,
    firstName: "Ada",
    lastName: "Administrator",
    email: adminEmail,
    password: personaPassword,
  },
  {
    personId: memberPersonId,
    firstName: "Mona",
    lastName: "Medlem",
    email: memberEmail,
    password: personaPassword,
  },
];
const authorityFixturesByPersonId = new Map([
  [adminPersonId, "active-global-administrator-grant"],
  [memberPersonId, "active-unsuspended-ordinary-member-membership"],
]);
const seedSql = `
BEGIN;
INSERT INTO organization_departments (
  department_id, name, short_name, email, city, active, revision
) VALUES (
  '${fixtureDepartmentId}', 'Vektorprogrammet Medlemsavdeling', 'Medlemsavdeling',
  'medlemsavdeling@example.invalid', 'Trondheim', TRUE, 0
);
INSERT INTO person_contact_profiles (person_id, email, phone, revision)
VALUES
  ('${adminPersonId}', '${adminEmail}', '+47 900 00 052', 0),
  ('${memberPersonId}', '${memberEmail}', '+47 900 00 053', 0);
INSERT INTO organization_teams (team_id, department_id, name, active, revision)
VALUES (
  '${fixtureTeamId}', '${fixtureDepartmentId}', 'Ordinært medlemsteam', TRUE, 0
);
INSERT INTO organization_memberships (
  membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
  position_id, is_team_leader, is_suspended, revision
) VALUES (
  'membership-organization-member-0052', '${memberPersonId}', '${fixtureTeamId}', NULL,
  '2020-01-01T00:00:00.000Z', NULL, 'member', FALSE, FALSE, 0
);
INSERT INTO organization_global_administrator_grants (
  grant_id, person_id, start_at, end_at, revision
) VALUES (
  'global-administrator-organization-0052', '${adminPersonId}',
  '2020-01-01T00:00:00.000Z', NULL, 0
);
COMMIT;
`;
const journeyRefId = "intent://journey:parity:org_admin:v1";
const journeyStepIds = [
  "org-admin-api-operation",
  "org-admin-command-write",
  "org-admin-legacy-route",
  "org-admin-mono-route",
];
const commandIds = {
  department: "organization-department-create-0052",
  team: "organization-team-create-0052",
  fieldOfStudy: "organization-field-create-0052",
  unknownDepartment: "organization-team-unknown-department-0052",
  memberDenied: "organization-member-denied-0052",
};
const dockerAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const postgresTopology = dockerAvailable ? "docker" : "local";
const runnerPath = fileURLToPath(import.meta.url);
const specPath = join(dashboardRoot, "e2e/native-organization-administration.spec.ts");

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

function signalProcessGroup(child, signal) {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
      throw error;
    }
  }
}

function runCommand(command, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const captureOutput = options.captureOutput === true;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      detached: true,
    });
    const stdout = [];
    const stderr = [];
    if (captureOutput) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    let settled = false;
    const timeout = setTimeout(() => {
      signalProcessGroup(child, "SIGTERM");
      const hardKill = setTimeout(() => signalProcessGroup(child, "SIGKILL"), shutdownTimeoutMs);
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
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolveCommand(captureOutput ? output : undefined);
        return;
      }
      const detail =
        captureOutput && output.stderr.trim().length > 0 ? `: ${output.stderr.trim()}` : "";
      rejectCommand(
        new Error(
          `${options.label} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}${detail}`,
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
  if (child === undefined || child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  signalProcessGroup(child, "SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    sleep(shutdownTimeoutMs).then(() => false),
  ]);
  if (stopped) return;
  signalProcessGroup(child, "SIGKILL");
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
        label: "Disposable Organization PostgreSQL readiness check",
        captureOutput: true,
      };
      if (postgresTopology === "docker") await runCommand("docker", args, options);
      else await runNixPostgres("pg_isready", args, options);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Disposable Organization PostgreSQL did not become ready");
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
      label: "Local Organization PostgreSQL initialization",
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
      label: "Local Organization PostgreSQL startup",
    },
  );
  await waitForPostgres(environment);
  await runNixPostgres(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local Organization PostgreSQL database creation",
    },
  );
}

async function stopLocalPostgres(dataRoot, environment) {
  await runNixPostgres("pg_ctl", ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    label: "Local Organization PostgreSQL cleanup",
  });
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

async function runPsql(sql, environment, label) {
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
    label,
    captureOutput: true,
  };
  return postgresTopology === "docker"
    ? runCommand("docker", args, options)
    : runNixPostgres("psql", args, options);
}

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
const sessionCookieKey = (cookieHeader) => {
  if (typeof cookieHeader !== "string") return undefined;
  const sessionPairs = cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => {
      const separator = pair.indexOf("=");
      return separator > 0 && sessionCookieNames.has(pair.slice(0, separator).trim());
    })
    .sort();
  return sessionPairs.length === 0 ? undefined : sessionPairs.join("; ");
};

async function startRecordingProxy(targetOrigin) {
  const records = [];
  const sessionPersonsByCookie = new Map();
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", targetOrigin);
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBytes = Buffer.concat(chunks);
    const cookieKey = sessionCookieKey(request.headers.cookie);
    const record = {
      method,
      path: url.pathname,
      query: url.search,
      sessionCookieAuth: cookieKey !== undefined,
      authorizationHeaderPresent: request.headers.authorization !== undefined,
      sessionPersonId:
        cookieKey === undefined ? null : (sessionPersonsByCookie.get(cookieKey) ?? null),
      canonicalAuthorityFixture: null,
      request: parseJsonBody(requestBytes),
      status: 0,
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
      const setCookie = upstream.headers.getSetCookie();
      if (setCookie.length > 0) response.setHeader("set-cookie", setCookie);
      response.setHeader("content-length", String(responseBytes.byteLength));
      response.end(responseBytes);
    } catch {
      record.status = 502;
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end('{"error":"native Organization evidence proxy failed"}');
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
    throw new Error("Native Organization evidence proxy did not bind a loopback port");
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

const readJsonFile = async (path, label) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is missing or malformed`);
  }
};

async function readDatabaseEvidence(environment) {
  const acceptedIds = [commandIds.department, commandIds.team, commandIds.fieldOfStudy]
    .map((commandId) => `'${commandId}'`)
    .join(",");
  const result = await runPsql(
    `SELECT json_build_object(
      'entities', json_build_object(
        'departments', (SELECT count(*) FROM organization_departments WHERE name = 'Vektorprogrammet Nord'),
        'teams', (SELECT count(*) FROM organization_teams WHERE name = 'Team Nordlys'),
        'fieldOfStudies', (SELECT count(*) FROM organization_field_of_studies WHERE name = 'Romteknologi'),
        'unknownDepartmentTeams', (SELECT count(*) FROM organization_teams WHERE name = 'Team Nordlys' AND department_id = 'department-does-not-exist-0052'),
        'changedReplayDepartments', (SELECT count(*) FROM organization_departments WHERE name = 'Et annet navn')
      ),
      'authorityFixtures', json_build_object(
        'identityUsers', (SELECT count(*) FROM auth."user" WHERE id IN ('${adminPersonId}', '${memberPersonId}')),
        'credentialAccounts', (SELECT count(*) FROM auth.account WHERE "userId" IN ('${adminPersonId}', '${memberPersonId}') AND "providerId" = 'credential'),
        'contactProfiles', (SELECT count(*) FROM person_contact_profiles WHERE person_id IN ('${adminPersonId}', '${memberPersonId}')),
        'fixtureDepartments', (SELECT count(*) FROM organization_departments WHERE department_id = '${fixtureDepartmentId}' AND active),
        'fixtureTeams', (SELECT count(*) FROM organization_teams WHERE team_id = '${fixtureTeamId}' AND department_id = '${fixtureDepartmentId}' AND active),
        'adminActiveGlobalGrants', (SELECT count(*) FROM organization_global_administrator_grants WHERE person_id = '${adminPersonId}' AND start_at <= now() AND (end_at IS NULL OR now() < end_at)),
        'memberActiveGlobalGrants', (SELECT count(*) FROM organization_global_administrator_grants WHERE person_id = '${memberPersonId}' AND start_at <= now() AND (end_at IS NULL OR now() < end_at)),
        'memberActiveOrdinaryMemberships', (
          SELECT count(*)
          FROM organization_memberships membership
          JOIN organization_teams team ON team.team_id = membership.team_id
          JOIN organization_departments department ON department.department_id = team.department_id
          WHERE membership.person_id = '${memberPersonId}'
            AND membership.team_id = '${fixtureTeamId}'
            AND membership.start_at <= now()
            AND (membership.end_at IS NULL OR now() < membership.end_at)
            AND NOT membership.is_team_leader
            AND NOT membership.is_suspended
            AND team.active
            AND department.active
        )
      ),
      'receipts', (SELECT coalesce(json_agg(to_jsonb(receipt) ORDER BY command_id), '[]'::json) FROM organization_command_receipts receipt WHERE command_id IN (${acceptedIds})),
      'audits', (SELECT coalesce(json_agg(to_jsonb(audit) ORDER BY command_id), '[]'::json) FROM organization_creation_audit audit WHERE command_id IN (${acceptedIds})),
      'provenanceLinks', (
        SELECT count(*)
        FROM (
          SELECT native_creation_command_id AS command_id, 'Department' AS entity_kind, department_id AS entity_id
          FROM organization_departments
          WHERE native_creation_command_id IN (${acceptedIds})
          UNION ALL
          SELECT native_creation_command_id, 'Team', team_id
          FROM organization_teams
          WHERE native_creation_command_id IN (${acceptedIds})
          UNION ALL
          SELECT native_creation_command_id, 'FieldOfStudy', field_of_study_id
          FROM organization_field_of_studies
          WHERE native_creation_command_id IN (${acceptedIds})
        ) entity
        JOIN organization_command_receipts receipt
          ON receipt.command_id = entity.command_id
          AND receipt.entity_kind = entity.entity_kind
          AND receipt.entity_id = entity.entity_id
        JOIN organization_creation_audit audit
          ON audit.command_id = receipt.command_id
          AND audit.entity_kind = receipt.entity_kind
          AND audit.entity_id = receipt.entity_id
          AND audit.actor_person_id = receipt.actor_person_id
          AND audit.occurred_at = receipt.committed_at
      ),
      'deniedReceipts', (SELECT count(*) FROM organization_command_receipts WHERE command_id IN ('${commandIds.unknownDepartment}', '${commandIds.memberDenied}')),
      'deniedAudits', (SELECT count(*) FROM organization_creation_audit WHERE command_id IN ('${commandIds.unknownDepartment}', '${commandIds.memberDenied}'))
    )::text;`,
    environment,
    "Native Organization PostgreSQL evidence query",
  );
  const source = result.stdout.trim();
  if (source.length === 0)
    throw new Error("Organization PostgreSQL evidence query returned no JSON");
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("Organization PostgreSQL evidence query returned malformed JSON");
  }
}

const assertEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} was ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`,
    );
  }
};

function assertDatabaseEvidence(evidence) {
  assertEqual(
    evidence.entities,
    {
      departments: 1,
      teams: 1,
      fieldOfStudies: 1,
      unknownDepartmentTeams: 0,
      changedReplayDepartments: 0,
    },
    "Native Organization entity counts",
  );
  assertEqual(
    evidence.authorityFixtures,
    {
      identityUsers: 2,
      credentialAccounts: 2,
      contactProfiles: 2,
      fixtureDepartments: 1,
      fixtureTeams: 1,
      adminActiveGlobalGrants: 1,
      memberActiveGlobalGrants: 0,
      memberActiveOrdinaryMemberships: 1,
    },
    "Native Organization persona and authority fixtures",
  );
  assertEqual(evidence.receipts.length, 3, "Native Organization receipt count");
  assertEqual(evidence.audits.length, 3, "Native Organization audit count");
  assertEqual(evidence.provenanceLinks, 3, "Native Organization provenance linkage count");
  assertEqual(evidence.deniedReceipts, 0, "Rejected Organization receipt count");
  assertEqual(evidence.deniedAudits, 0, "Rejected Organization audit count");
  assertEqual(
    [...new Set(evidence.receipts.map(({ actor_person_id: personId }) => personId))],
    [adminPersonId],
    "Native Organization receipt actors",
  );
  assertEqual(
    [...new Set(evidence.audits.map(({ actor_person_id: personId }) => personId))],
    [adminPersonId],
    "Native Organization audit actors",
  );
  const requiredReceiptFields = [
    "command_id",
    "command_sha256",
    "command_json",
    "observation_json",
    "entity_kind",
    "entity_id",
    "actor_json",
    "actor_person_id",
    "committed_at",
  ];
  for (const receipt of evidence.receipts) {
    const missing = requiredReceiptFields.filter((field) => !(field in receipt));
    if (missing.length > 0) {
      throw new Error(`Organization receipt omitted canonical fields: ${missing.join(", ")}`);
    }
  }
  const requiredAuditFields = [
    "command_id",
    "entity_kind",
    "entity_id",
    "actor_person_id",
    "action",
    "occurred_at",
  ];
  for (const audit of evidence.audits) {
    const missing = requiredAuditFields.filter((field) => !(field in audit));
    if (missing.length > 0) {
      throw new Error(`Organization audit omitted canonical fields: ${missing.join(", ")}`);
    }
  }
}

const receiptRequested = () =>
  [
    "RUNTIME_EVIDENCE_RECEIPT_PATH",
    "RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_MONO_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS",
  ].some((name) => typeof process.env[name] === "string" && process.env[name].length > 0);

async function emitReceipt(playwrightOutput) {
  if (!receiptRequested()) return;
  const sourceRefIds = (process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const sourcePaths = [runnerPath, specPath];
  if (sourceRefIds.length === 0 || sourceRefIds.length > sourcePaths.length) {
    throw new Error("Native Organization runtime evidence expects one or two source references");
  }
  const runnerSourceInputBytes = await Promise.all(
    sourceRefIds.map(async (sourceRefId, index) => ({
      sourceRefId,
      bytes: await readFile(sourcePaths[index]),
    })),
  );
  const fixtureInputBytes = Buffer.from(
    JSON.stringify({ adminPersonId, memberPersonId, commandIds }),
    "utf8",
  );
  await emitRuntimeEvidenceReceipt({
    journeyRefId,
    stepIds: journeyStepIds,
    fixtureId: "native-organization-administration-0052",
    runnerSourceInputBytes,
    fixtureInputBytes,
    artifactBytes: sanitizePlaywrightArtifact(Buffer.from(playwrightOutput, "utf8")),
  });
}

async function main() {
  await Promise.all([
    assertPortAvailable(dashboardPort),
    assertPortAvailable(backendPort),
    assertPortAvailable(postgresPort),
  ]);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-native-organization-0052-"));
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const stagingRoot = join(temporaryRoot, "receipt-staging");
  const committedRoot = join(temporaryRoot, "receipt-committed");
  const browserEvidencePath = join(temporaryRoot, "browser-evidence.json");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);

  const baseEnvironment = { ...process.env };
  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;
  delete baseEnvironment.ALCHEMY_CLOUDFLARE_VITE_INJECTED;
  delete baseEnvironment.ORGANIZATION_AUTH_TOKENS;
  delete baseEnvironment.ADMISSION_AUTH_TOKENS;
  delete baseEnvironment.RECEIPT_AUTH_TOKENS;
  const apiEnvironment = {
    ...baseEnvironment,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: betterAuthSecret,
    BETTER_AUTH_URL: dashboardOrigin,
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
              label: "Disposable Organization PostgreSQL cleanup",
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
      throw new AggregateError(cleanupErrors, "Native Organization topology cleanup failed");
    }
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
    postgresStarted = true;
    if (postgresTopology === "docker") {
      await runCommand(
        "docker",
        ["compose", "-f", composeFile, "-p", composeProject, "up", "-d", "receipt-postgres"],
        {
          cwd: repositoryRoot,
          env: baseEnvironment,
          label: "Disposable Organization PostgreSQL startup",
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
        IDENTITY_SEED_PERSONS: JSON.stringify(identitySeedPersons),
      },
      label: "Disposable Organization Identity seed",
    });
    await runPsql(seedSql, baseEnvironment, "Native Organization authority fixture seed");
    proxy = await startRecordingProxy(backendOrigin);

    const journeyEnvironment = {
      ...baseEnvironment,
      API_URL: proxy.origin,
      VITE_API_URL: proxy.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      BETTER_AUTH_SECRET: betterAuthSecret,
      BETTER_AUTH_URL: dashboardOrigin,
      REAL_NATIVE_ORGANIZATION_E2E: "1",
      REAL_NATIVE_CONDUCT_E2E: "1",
      ORGANIZATION_E2E_ADMIN_EMAIL: adminEmail,
      ORGANIZATION_E2E_ADMIN_PASSWORD: personaPassword,
      ORGANIZATION_E2E_ADMIN_PERSON_ID: adminPersonId,
      ORGANIZATION_E2E_MEMBER_EMAIL: memberEmail,
      ORGANIZATION_E2E_MEMBER_PASSWORD: personaPassword,
      ORGANIZATION_E2E_MEMBER_PERSON_ID: memberPersonId,
      ORGANIZATION_E2E_BROWSER_EVIDENCE_PATH: browserEvidencePath,
      BACKEND_PG_URL: postgresUrl,
    };
    await runCommand("bun", ["run", "build"], {
      cwd: sdkRoot,
      env: journeyEnvironment,
      label: "Native Organization SDK build",
    });
    dashboardProcess = startProcess(
      process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
      [
        "node_modules/@react-router/dev/dist/cli/index.js",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(dashboardPort),
      ],
      { cwd: dashboardRoot, env: journeyEnvironment },
    );
    await waitForHttp(`${dashboardOrigin}/login`, dashboardProcess, "Dashboard");

    const playwrightArgs = [
      "./node_modules/@playwright/test/cli.js",
      "test",
      "e2e/native-organization-administration.spec.ts",
      "--project=chromium",
      "--workers=1",
      "--retries=0",
    ];
    if (receiptRequested()) playwrightArgs.push("--reporter=json");
    const playwright = await runCommand(
      process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
      playwrightArgs,
      {
        cwd: dashboardRoot,
        env: journeyEnvironment,
        label: "Native Organization Playwright journey",
        captureOutput: receiptRequested(),
      },
    );

    const browser = await readJsonFile(browserEvidencePath, "Native Organization browser evidence");
    assertEqual(browser.journeyRefId, journeyRefId, "Organization journey reference");
    assertEqual(
      [...browser.acceptedStepIds].sort(),
      [...journeyStepIds].sort(),
      "Organization steps",
    );
    assertEqual(browser.browser.legacyBrowserRequests, [], "Symfony Organization browser requests");
    assertEqual(browser.browser.pageErrors, [], "Organization browser page errors");
    assertEqual(
      browser.browser.accessibilityViolations,
      { team: 0, fieldOfStudy: 0 },
      "Organization accessibility violations",
    );
    assertEqual(
      browser.sessions,
      {
        administrator: {
          nativeLogin: true,
          sessionCookieNames: ["better-auth.session_token"],
          apiSessionPath: "/api/me/session",
          personId: adminPersonId,
        },
        member: {
          nativeLogin: true,
          sessionCookieNames: ["better-auth.session_token"],
          apiSessionPath: "/api/me/session",
          personId: memberPersonId,
        },
      },
      "Native Organization rendered-login sessions",
    );
    const resolvedSessionPersonIds = [
      ...new Set(
        proxy.records
          .filter(
            ({ path, status, sessionCookieAuth, authorizationHeaderPresent }) =>
              path === "/api/me/session" &&
              status === 200 &&
              sessionCookieAuth &&
              !authorizationHeaderPresent,
          )
          .map(({ sessionPersonId }) => sessionPersonId),
      ),
    ].sort();
    assertEqual(
      resolvedSessionPersonIds,
      [adminPersonId, memberPersonId].sort(),
      "Native Organization session PersonIds",
    );
    const database = await readDatabaseEvidence(baseEnvironment);
    assertDatabaseEvidence(database);

    const organizationRequests = proxy.records.filter(({ path }) =>
      [
        "/api/admin/departments",
        "/api/admin/teams",
        "/api/admin/field-of-studies",
        "/api/departments",
        "/api/teams",
        "/api/field_of_studies",
      ].includes(path),
    );
    const statusFacts = organizationRequests
      .filter(({ method }) => method === "POST")
      .map(
        ({
          path,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          sessionPersonId,
          canonicalAuthorityFixture,
          request,
        }) => ({
          path,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          sessionPersonId,
          canonicalAuthorityFixture,
          commandId: request?.commandId,
        }),
      );
    const expectedStatusFacts = [
      [
        "/api/admin/departments",
        201,
        true,
        false,
        adminPersonId,
        "active-global-administrator-grant",
        commandIds.department,
      ],
      [
        "/api/admin/teams",
        201,
        true,
        false,
        adminPersonId,
        "active-global-administrator-grant",
        commandIds.team,
      ],
      [
        "/api/admin/field-of-studies",
        201,
        true,
        false,
        adminPersonId,
        "active-global-administrator-grant",
        commandIds.fieldOfStudy,
      ],
      [
        "/api/admin/teams",
        422,
        true,
        false,
        adminPersonId,
        "active-global-administrator-grant",
        commandIds.unknownDepartment,
      ],
      [
        "/api/admin/departments",
        403,
        true,
        false,
        memberPersonId,
        "active-unsuspended-ordinary-member-membership",
        commandIds.memberDenied,
      ],
      [
        "/api/admin/departments",
        200,
        true,
        false,
        adminPersonId,
        "active-global-administrator-grant",
        commandIds.department,
      ],
      [
        "/api/admin/departments",
        409,
        true,
        false,
        adminPersonId,
        "active-global-administrator-grant",
        commandIds.department,
      ],
    ];
    assertEqual(
      statusFacts.map(
        ({
          path,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          sessionPersonId,
          canonicalAuthorityFixture,
          commandId,
        }) => [
          path,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          sessionPersonId,
          canonicalAuthorityFixture,
          commandId,
        ],
      ),
      expectedStatusFacts,
      "Native Organization transport facts",
    );
    if (organizationRequests.some(({ query }) => query !== "")) {
      throw new Error("Native Organization transport unexpectedly used query parameters");
    }
    if (organizationRequests.some(({ authorizationHeaderPresent }) => authorizationHeaderPresent)) {
      throw new Error("Native Organization transport unexpectedly used Authorization");
    }
    if (receiptRequested()) await emitReceipt(playwright.stdout);

    evidence = {
      topology: {
        dashboard: "loopback-react-router-playwright-server",
        api: "unified-native-effect-backend",
        database:
          postgresTopology === "docker"
            ? "disposable-postgresql-docker"
            : "disposable-postgresql-local-nix",
        browser: "real-chromium",
        symfonyProcessesStarted: 0,
      },
      journeyRefId,
      acceptedStepIds: journeyStepIds,
      browser,
      nativeTransport: organizationRequests.map(
        ({
          method,
          path,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          sessionPersonId,
          canonicalAuthorityFixture,
        }) => ({
          method,
          path,
          status,
          sessionCookieAuth,
          authorizationHeaderPresent,
          sessionPersonId,
          canonicalAuthorityFixture,
        }),
      ),
      postgres: database,
      symfonyOrganizationRequests: [],
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await cleanup();
    if (await pathExists(temporaryRoot)) {
      throw new Error("Native Organization cleanup left the temporary root behind");
    }
    await Promise.all([
      waitForPortRelease(dashboardPort),
      waitForPortRelease(backendPort),
      waitForPortRelease(postgresPort),
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
      "Native Organization journey and cleanup failed",
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
        portsReleased: [dashboardPort, backendPort, postgresPort],
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
  process.stderr.write(
    `Real native Organization administration runner failed: ${errorDetail(error)}\n`,
  );
  process.exitCode = 1;
});
