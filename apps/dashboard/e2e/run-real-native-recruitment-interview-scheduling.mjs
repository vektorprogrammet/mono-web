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
const dashboardPort = 5184;
const backendPort = 8796;
const postgresPort = 55432;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const postgresUrl = `postgres://receipt:receipt@127.0.0.1:${postgresPort}/receipt_proof?connect_timeout=1`;
const composeProject = `mono-web-native-scheduling-0050-${process.pid}`;
const commandTimeoutMs = 300_000;
const shutdownTimeoutMs = 5_000;
const nixPostgresPackage = "nixpkgs#postgresql_17";
const fixedClock = "2031-09-15T12:00:00.000Z";
const departmentId = "department-native-scheduling-0050";
const semesterId = "semester-native-scheduling-0050";
const admissionPeriodId = "admission-period-native-scheduling-0050";
const fieldOfStudyId = "field-native-scheduling-0050";
const actorPersonId = "person-native-scheduling-leader-0050";
const interviewerPersonId = "person-native-scheduling-interviewer-0050";
const recruitmentTeamId = "team-native-scheduling-0050";
const applicantId = "applicant-native-scheduling-0050";
const applicationId = "application-native-scheduling-0050";
const interviewSchemaId = "interview-schema-native-scheduling-0050";
const interviewId = "interview-native-scheduling-0050";
const applicantName = "Sofie Søker";
const interviewerName = "Irene Intervjuer";
const leaderEmail = "lina.lagleder@example.invalid";
const interviewerEmail = "irene.intervjuer@example.invalid";
const personaPassword = "native-scheduling-0050-secret-0123456789";
const betterAuthSecret = randomBytes(32).toString("base64url");
const schedule = {
  scheduledAt: "2031-09-20T13:30:00.000Z",
  room: "K-101",
  campus: "Gløshaugen",
  mapLink: "https://maps.example.invalid/native-scheduling-0050",
  message: "Vi ser frem til intervjuet.",
};
const journeyRefId = "intent://journey:recruitment:interview-scheduling:v1";
const journeyStepIds = [
  "interviewer-session-login",
  "leader-session-login",
  "load-assigned-interviews",
  "schedule-interview",
];
const dockerAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const postgresTopology = dockerAvailable ? "docker" : "local";
const runnerPath = fileURLToPath(import.meta.url);
const specPath = join(dashboardRoot, "e2e/native-recruitment-interview-scheduling.spec.ts");
const recordingDriverPath = join(dashboardRoot, "e2e/record-native-recruitment-invitation.ts");

const seedSql = `
BEGIN;
INSERT INTO admission_period_departments (department_id, name)
VALUES ('${departmentId}', 'Trondheim');
INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
VALUES ('${semesterId}', '2031-08-01T00:00:00.000Z', '2032-01-01T00:00:00.000Z');
INSERT INTO admission_periods (
  admission_period_id, department_id, semester_id, start_at, end_at, revision, last_command_id
) VALUES (
  '${admissionPeriodId}', '${departmentId}', '${semesterId}',
  '2031-09-01T00:00:00.000Z', '2031-10-01T00:00:00.000Z', 0,
  'admission-period-native-scheduling-seed-0050'
);
INSERT INTO admission_period_fields_of_study (
  field_of_study_id, department_id, name, active
) VALUES ('${fieldOfStudyId}', '${departmentId}', 'Datateknologi', TRUE);
INSERT INTO admission_applicants (
  applicant_id, normalized_email, email, first_name, last_name, phone,
  gender, field_of_study_id, year_of_study, activation_digest
) VALUES (
  '${applicantId}', 'sofie.soker@example.invalid', 'sofie.soker@example.invalid',
  'Sofie', 'Søker', '90000050', 1, '${fieldOfStudyId}', 3, NULL
);
INSERT INTO admission_applications (
  application_id, applicant_id, admission_period_id, department_id,
  field_of_study_id, year_of_study, submitted_at, revision
) VALUES (
  '${applicationId}', '${applicantId}', '${admissionPeriodId}', '${departmentId}',
  '${fieldOfStudyId}', 3, '2031-09-10T10:00:00.000Z', 0
);
INSERT INTO organization_departments (
  department_id, name, short_name, email, city, active, revision
) VALUES (
  '${departmentId}', 'Vektorprogrammet Trondheim', 'Trondheim',
  'trondheim@example.invalid', 'Trondheim', TRUE, 0
);
INSERT INTO person_profiles (person_id, first_name, last_name, revision)
VALUES
  ('${actorPersonId}', 'Lina', 'Lagleder', 0),
  ('${interviewerPersonId}', 'Irene', 'Intervjuer', 0);
INSERT INTO person_contact_profiles (person_id, email, phone, revision)
VALUES
  ('${actorPersonId}', 'lina.lagleder@example.invalid', '+47 900 00 051', 0),
  ('${interviewerPersonId}', 'irene.intervjuer@example.invalid', '+47 900 00 052', 0);
INSERT INTO organization_teams (team_id, department_id, name, active, revision)
VALUES ('${recruitmentTeamId}', '${departmentId}', 'Rekruttering', TRUE, 0);
INSERT INTO organization_memberships (
  membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
  position_id, is_team_leader, is_suspended, revision
) VALUES
(
  'membership-native-scheduling-leader-0050', '${actorPersonId}',
  '${recruitmentTeamId}', NULL, '2020-01-01T00:00:00.000Z', NULL,
  'teamleader', TRUE, FALSE, 0
),
(
  'membership-native-scheduling-interviewer-0050', '${interviewerPersonId}',
  '${recruitmentTeamId}', NULL, '2020-01-01T00:00:00.000Z', NULL,
  'interviewer', FALSE, FALSE, 0
);
INSERT INTO recruitment_interview_schemas (
  interview_schema_id, name, question_count, active, revision
) VALUES ('${interviewSchemaId}', 'Førstegangsintervju', 8, TRUE, 0);
INSERT INTO public.recruitment_interview_schema_questions (
  interview_schema_id, question_id, ordinal, prompt, help_text, kind, alternatives
) VALUES
  ('${interviewSchemaId}', '${interviewSchemaId}-q0', 0, 'Question 0', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q1', 1, 'Question 1', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q2', 2, 'Question 2', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q3', 3, 'Question 3', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q4', 4, 'Question 4', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q5', 5, 'Question 5', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q6', 6, 'Question 6', NULL, 'text', '[]'::jsonb),
  ('${interviewSchemaId}', '${interviewSchemaId}-q7', 7, 'Question 7', NULL, 'text', '[]'::jsonb);
INSERT INTO recruitment_interviews (
  interview_id, application_id, department_id, interviewer_person_id,
  interview_schema_id, assigned_by_person_id, assigned_at, revision
) VALUES (
  '${interviewId}', '${applicationId}', '${departmentId}', '${interviewerPersonId}',
  '${interviewSchemaId}', '${actorPersonId}', '2031-09-12T09:00:00.000Z', 0
);
COMMIT;
`;

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
  if (child.pid === undefined) return;
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
        label: "Disposable scheduling PostgreSQL readiness check",
        captureOutput: true,
      };
      if (postgresTopology === "docker") await runCommand("docker", args, options);
      else await runNixPostgres("pg_isready", args, options);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Disposable scheduling PostgreSQL did not become ready");
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
      label: "Local scheduling PostgreSQL initialization",
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
      label: "Local scheduling PostgreSQL startup",
    },
  );
  await waitForPostgres(environment);
  await runNixPostgres(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local scheduling PostgreSQL database creation",
    },
  );
}

async function stopLocalPostgres(dataRoot, environment) {
  await runNixPostgres("pg_ctl", ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    label: "Local scheduling PostgreSQL cleanup",
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

const hasObjectKey = (value, key) => {
  if (Array.isArray(value)) return value.some((item) => hasObjectKey(item, key));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([entryKey, entryValue]) => entryKey === key || hasObjectKey(entryValue, key),
  );
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
const hasSessionCookie = (cookieHeader) =>
  typeof cookieHeader === "string" &&
  cookieHeader.split(";").some((pair) => {
    const separator = pair.indexOf("=");
    return separator > 0 && sessionCookieNames.has(pair.slice(0, separator).trim());
  });

async function startRecordingProxy(targetOrigin) {
  const records = [];
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", targetOrigin).pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBytes = Buffer.concat(chunks);
    const requestJson = parseJsonBody(requestBytes);
    const record = {
      method,
      path,
      sessionCookieAuth: hasSessionCookie(request.headers.cookie),
      authorizationHeaderPresent: request.headers.authorization !== undefined,
      requestHasResponseCapability: hasObjectKey(requestJson, "responseCapability"),
      responseHasResponseCapability: false,
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
      record.status = upstream.status;
      record.responseHasResponseCapability = hasObjectKey(
        parseJsonBody(responseBytes),
        "responseCapability",
      );
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
      response.end('{"error":"native scheduling evidence proxy failed"}');
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
    throw new Error("Native scheduling evidence proxy did not bind a loopback port");
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

const parseJsonOutput = (result, label) => {
  const source = result.stdout.trim();
  if (source.length === 0) throw new Error(`${label} returned no JSON evidence`);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} returned malformed JSON evidence`);
  }
};

const readJsonFile = async (path, label) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is missing or malformed`);
  }
};

async function readScheduleEvidence(environment) {
  const result = await runPsql(
    `
      SELECT json_build_object(
        'schedule', (
          SELECT json_build_object(
            'interviewId', interview_id,
            'scheduledAt', to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'room', room,
            'campus', campus,
            'mapLink', map_link,
            'message', message,
            'scheduledByPersonId', scheduled_by_person_id,
            'scheduleRevision', schedule_revision
          )
          FROM recruitment_interview_schedules
          WHERE interview_id = '${interviewId}'
        ),
        'interviewRevision', (
          SELECT revision FROM recruitment_interviews WHERE interview_id = '${interviewId}'
        ),
        'invitation', (
          SELECT json_build_object(
            'invitationId', invitation_id,
            'interviewId', interview_id,
            'scheduleRevision', schedule_revision,
            'responseState', response_state
          )
          FROM recruitment_invitations
          WHERE interview_id = '${interviewId}'
        ),
        'receipt', (
          SELECT json_build_object(
            'commandId', command_id,
            'interviewId', interview_id,
            'scheduleRevision', schedule_revision
          )
          FROM recruitment_schedule_command_receipts
          WHERE interview_id = '${interviewId}'
        ),
        'audit', (
          SELECT json_build_object(
            'commandId', command_id,
            'interviewId', interview_id,
            'scheduleRevision', schedule_revision,
            'actorPersonId', actor_person_id,
            'action', action
          )
          FROM recruitment_schedule_audit
          WHERE interview_id = '${interviewId}'
        ),
        'outbox', (
          SELECT json_build_object(
            'effectId', effect_id,
            'commandId', command_id,
            'interviewId', interview_id,
            'invitationId', invitation_id,
            'scheduleRevision', schedule_revision,
            'status', status,
            'attempts', attempts,
            'payloadStored', payload_json <> '{}'::jsonb,
            'claimCleared', claim_id IS NULL AND claimed_at IS NULL,
            'deliveredAt', CASE WHEN delivered_at IS NULL THEN NULL ELSE
              to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
          )
          FROM recruitment_invitation_outbox
          WHERE interview_id = '${interviewId}'
        ),
        'counts', json_build_object(
          'schedules', (SELECT count(*) FROM recruitment_interview_schedules WHERE interview_id = '${interviewId}'),
          'invitations', (SELECT count(*) FROM recruitment_invitations WHERE interview_id = '${interviewId}'),
          'receipts', (SELECT count(*) FROM recruitment_schedule_command_receipts WHERE interview_id = '${interviewId}'),
          'audits', (SELECT count(*) FROM recruitment_schedule_audit WHERE interview_id = '${interviewId}'),
          'outbox', (SELECT count(*) FROM recruitment_invitation_outbox WHERE interview_id = '${interviewId}')
        )
      )::text;
    `,
    environment,
    "Native scheduling PostgreSQL evidence read",
  );
  return parseJsonOutput(result, "Native scheduling PostgreSQL evidence read");
}

const assertEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not match the frozen native scheduling journey`);
  }
};

function assertPendingScheduleEvidence(evidence) {
  assertEqual(
    evidence.schedule,
    {
      interviewId,
      scheduledAt: schedule.scheduledAt,
      room: schedule.room,
      campus: schedule.campus,
      mapLink: schedule.mapLink,
      message: schedule.message,
      scheduledByPersonId: actorPersonId,
      scheduleRevision: 1,
    },
    "Stored schedule",
  );
  assertEqual(evidence.interviewRevision, 1, "Interview revision");
  if (
    evidence.invitation?.interviewId !== interviewId ||
    evidence.invitation?.scheduleRevision !== 1 ||
    evidence.invitation?.responseState !== "Pending"
  ) {
    throw new Error("Invitation did not remain a separate Pending response authority");
  }
  if (
    evidence.receipt?.interviewId !== interviewId ||
    evidence.receipt?.scheduleRevision !== 1 ||
    evidence.audit?.commandId !== evidence.receipt?.commandId ||
    evidence.audit?.actorPersonId !== actorPersonId ||
    evidence.audit?.action !== "InterviewScheduled"
  ) {
    throw new Error("Schedule receipt and audit authority links are incomplete");
  }
  if (
    evidence.outbox?.status !== "Pending" ||
    evidence.outbox?.attempts !== 0 ||
    evidence.outbox?.payloadStored !== true ||
    evidence.outbox?.claimCleared !== true ||
    evidence.outbox?.commandId !== evidence.receipt?.commandId ||
    evidence.outbox?.invitationId !== evidence.invitation?.invitationId
  ) {
    throw new Error("Invitation outbox was not one pending canonical request");
  }
  assertEqual(
    evidence.counts,
    {
      schedules: 1,
      invitations: 1,
      receipts: 1,
      audits: 1,
      outbox: 1,
    },
    "Atomic scheduling row counts",
  );
}

function assertRecordingEvidence(recording, before, after) {
  if (
    recording.result !== "Delivered" ||
    recording.providerNetworkRequests !== 0 ||
    recording.responseCapabilityRedacted !== true ||
    recording.claim?.attempts !== 1 ||
    !Array.isArray(recording.requests) ||
    recording.requests.length !== 1
  ) {
    throw new Error("Recording NotificationGateway evidence is incomplete");
  }
  const request = recording.requests[0];
  if (
    request?._tag !== "SendInterviewInvitation" ||
    request?.effectId !== before.outbox.effectId ||
    request?.commandId !== before.receipt.commandId ||
    request?.interviewId !== interviewId ||
    request?.invitationId !== before.invitation.invitationId ||
    request?.scheduleRevision !== 1 ||
    request?.applicantEmail !== "sofie.soker@example.invalid" ||
    request?.applicantPhone !== "90000050" ||
    request?.interviewerDisplayName !== interviewerName ||
    request?.interviewerEmail !== "irene.intervjuer@example.invalid" ||
    request?.interviewerPhone !== "+47 900 00 052" ||
    request?.scheduledAt !== schedule.scheduledAt ||
    request?.room !== schedule.room ||
    request?.campus !== schedule.campus ||
    request?.mapLink !== schedule.mapLink ||
    request?.message !== schedule.message ||
    request?.responseCapability !== "[REDACTED]"
  ) {
    throw new Error("Recording gateway did not observe the canonical redacted invitation request");
  }
  if (
    after.outbox?.status !== "Delivered" ||
    after.outbox?.attempts !== 1 ||
    after.outbox?.payloadStored !== false ||
    after.outbox?.claimCleared !== true ||
    after.outbox?.deliveredAt !== "2031-09-20T13:31:01.000Z" ||
    after.invitation?.responseState !== "Pending"
  ) {
    throw new Error("Delivered outbox evidence did not scrub the sensitive payload");
  }
  assertEqual(after.counts, before.counts, "Post-interpretation scheduling row counts");
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
  const sourcePaths = [runnerPath, specPath, recordingDriverPath];
  if (sourceRefIds.length === 0 || sourceRefIds.length > sourcePaths.length) {
    throw new Error(
      "Native scheduling runtime evidence expects one to three runner source references",
    );
  }
  const runnerSourceInputBytes = await Promise.all(
    sourceRefIds.map(async (sourceRefId, index) => ({
      sourceRefId,
      bytes: await readFile(sourcePaths[index]),
    })),
  );
  const fixtureInputBytes = Buffer.concat([
    Buffer.from(seedSql, "utf8"),
    await readFile(recordingDriverPath),
  ]);
  await emitRuntimeEvidenceReceipt({
    journeyRefId,
    stepIds: journeyStepIds,
    fixtureId: "native-recruitment-interview-scheduling-0050",
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

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-native-scheduling-0050-"));
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const stagingRoot = join(temporaryRoot, "receipt-staging");
  const committedRoot = join(temporaryRoot, "receipt-committed");
  const browserEvidencePath = join(temporaryRoot, "browser-evidence.json");
  const recordingEvidencePath = join(temporaryRoot, "recording-evidence.json");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);

  const identitySeedPersons = [
    {
      personId: actorPersonId,
      firstName: "Lina",
      lastName: "Lagleder",
      email: leaderEmail,
      password: personaPassword,
    },
    {
      personId: interviewerPersonId,
      firstName: "Irene",
      lastName: "Intervjuer",
      email: interviewerEmail,
      password: personaPassword,
    },
  ];
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;
  delete baseEnvironment.ALCHEMY_CLOUDFLARE_VITE_INJECTED;
  const apiEnvironment = {
    ...baseEnvironment,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: betterAuthSecret,
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
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
              label: "Disposable scheduling PostgreSQL cleanup",
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
      throw new AggregateError(cleanupErrors, "Native scheduling topology cleanup failed");
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
          label: "Disposable scheduling PostgreSQL startup",
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
    await runPsql(seedSql, baseEnvironment, "Native scheduling fixture seed");
    await runCommand("bun", ["run", "identity:seed"], {
      cwd: databaseRoot,
      env: {
        ...apiEnvironment,
        IDENTITY_SEED_PG_URL: postgresUrl,
        IDENTITY_SEED_PERSONS: JSON.stringify(identitySeedPersons),
      },
      label: "Disposable scheduling Identity seed",
    });
    proxy = await startRecordingProxy(backendOrigin);

    const journeyEnvironment = {
      ...baseEnvironment,
      API_URL: proxy.origin,
      VITE_API_URL: proxy.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      BETTER_AUTH_SECRET: betterAuthSecret,
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
      REAL_NATIVE_SCHEDULING_E2E: "1",
      REAL_NATIVE_CONDUCT_E2E: "1",
      SCHEDULING_E2E_LEADER_EMAIL: leaderEmail,
      SCHEDULING_E2E_LEADER_PASSWORD: personaPassword,
      SCHEDULING_E2E_INTERVIEWER_EMAIL: interviewerEmail,
      SCHEDULING_E2E_INTERVIEWER_PASSWORD: personaPassword,
      SCHEDULING_E2E_APPLICANT_NAME: applicantName,
      SCHEDULING_E2E_INTERVIEWER_NAME: interviewerName,
      SCHEDULING_E2E_BROWSER_EVIDENCE_PATH: browserEvidencePath,
      BACKEND_PG_URL: postgresUrl,
      SCHEDULING_RECORDING_EVIDENCE_PATH: recordingEvidencePath,
    };
    await runCommand("bun", ["run", "build"], {
      cwd: sdkRoot,
      env: journeyEnvironment,
      label: "Native scheduling SDK build",
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
      "e2e/native-recruitment-interview-scheduling.spec.ts",
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
        label: "Native recruitment scheduling Playwright journey",
        captureOutput: receiptRequested(),
      },
    );
    const browser = await readJsonFile(browserEvidencePath, "Native scheduling browser evidence");
    if (
      browser.firstContextClosed !== true ||
      browser.independentContextPersisted !== true ||
      browser.accessibilityViolations !== 0 ||
      browser.rawCapabilityObserved !== false ||
      browser.bearerTokenInjected !== false ||
      JSON.stringify(browser.nativeActors) !== JSON.stringify(["DepartmentLeader", "Member"]) ||
      JSON.stringify(browser.sessionCookieNames?.leader) !==
        JSON.stringify(["better-auth.session_token"]) ||
      JSON.stringify(browser.sessionCookieNames?.interviewer) !==
        JSON.stringify(["better-auth.session_token"]) ||
      JSON.stringify(browser.bridgeOperations) !==
        JSON.stringify(["scheduleInterview", "readSchedulingBoard"]) ||
      !Array.isArray(browser.legacyBrowserRequests) ||
      browser.legacyBrowserRequests.length !== 0
    ) {
      throw new Error("Browser evidence did not prove the frozen Foldkit scheduling journey");
    }

    const schedulingRequests = proxy.records.filter(
      ({ path }) =>
        path === "/api/admin/recruitment/interviews/scheduling-board" ||
        path === "/api/admin/recruitment/interviews/schedule",
    );
    const leadingBoardReadCount = schedulingRequests.length - 3;
    if (leadingBoardReadCount !== 1 && leadingBoardReadCount !== 2) {
      throw new Error("Native scheduling transport had an unexpected request count");
    }
    const boardRead = {
      method: "GET",
      path: "/api/admin/recruitment/interviews/scheduling-board",
      sessionCookieAuth: true,
      authorizationHeaderPresent: false,
    };
    assertEqual(
      schedulingRequests.map(({ method, path, sessionCookieAuth, authorizationHeaderPresent }) => ({
        method,
        path,
        sessionCookieAuth,
        authorizationHeaderPresent,
      })),
      [
        ...Array.from({ length: leadingBoardReadCount }, () => boardRead),
        {
          method: "POST",
          path: "/api/admin/recruitment/interviews/schedule",
          sessionCookieAuth: true,
          authorizationHeaderPresent: false,
        },
        boardRead,
        boardRead,
      ],
      "Native scheduling transport order",
    );
    if (
      schedulingRequests.some(
        (request) =>
          !request.sessionCookieAuth ||
          request.authorizationHeaderPresent ||
          request.status !== 200 ||
          request.requestHasResponseCapability ||
          request.responseHasResponseCapability,
      ) ||
      proxy.records.some(
        ({ path }) => path === "/api/admin/interviews" || path.startsWith("/api/admin/interviews/"),
      )
    ) {
      throw new Error("Native scheduling transport used legacy authority or exposed a capability");
    }

    const beforeInterpretation = await readScheduleEvidence(baseEnvironment);
    assertPendingScheduleEvidence(beforeInterpretation);
    await runCommand("bun", [recordingDriverPath], {
      cwd: repositoryRoot,
      env: journeyEnvironment,
      label: "Recording Recruitment NotificationGateway driver",
    });
    const recording = await readJsonFile(
      recordingEvidencePath,
      "Recording Recruitment NotificationGateway evidence",
    );
    const afterInterpretation = await readScheduleEvidence(baseEnvironment);
    assertRecordingEvidence(recording, beforeInterpretation, afterInterpretation);
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
        notification: "recording-gateway-no-network",
        fixedClock,
      },
      browser,
      nativeTransport: {
        firstContext: schedulingRequests
          .slice(0, leadingBoardReadCount + 2)
          .map(({ method, path, status, sessionCookieAuth, authorizationHeaderPresent }) => ({
            method,
            path,
            status,
            sessionCookieAuth,
            authorizationHeaderPresent,
          })),
        independentContext: schedulingRequests
          .slice(leadingBoardReadCount + 2)
          .map(({ method, path, status, sessionCookieAuth, authorizationHeaderPresent }) => ({
            method,
            path,
            status,
            sessionCookieAuth,
            authorizationHeaderPresent,
          })),
        legacyRequests: [],
        rawCapabilityObserved: false,
      },
      postgres: {
        beforeInterpretation,
        afterInterpretation,
      },
      recording,
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    await cleanup();
    if (await pathExists(temporaryRoot)) {
      throw new Error("Native scheduling cleanup left the temporary root behind");
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
      "Native scheduling journey and cleanup failed",
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
    `Real native recruitment interview scheduling runner failed: ${errorDetail(error)}\n`,
  );
  process.exitCode = 1;
});
