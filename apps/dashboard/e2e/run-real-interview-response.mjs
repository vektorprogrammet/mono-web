import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
const domainRoot = fileURLToPath(new URL("../../../packages/domain/", import.meta.url));
const composeFile = join(repositoryRoot, "docker-compose.yml");
const runnerPath = fileURLToPath(import.meta.url);
const specPath = join(dashboardRoot, "e2e/real-interview-response.spec.ts");
const dashboardPort = 5185;
const backendPort = 8797;
const postgresPort = 55432;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const postgresUrl = `postgres://receipt:receipt@127.0.0.1:${postgresPort}/receipt_proof?connect_timeout=1`;
const composeProject = `mono-web-native-invitation-response-0051-${process.pid}`;
const commandTimeoutMs = 300_000;
const shutdownTimeoutMs = 5_000;
const nixPostgresPackage = "nixpkgs#postgresql_17";
const fixedClock = "2031-09-15T12:00:00.000Z";
const responseDeliveredAt = "2031-09-15T12:01:00.000Z";
const departmentId = "department-native-invitation-response-0051";
const semesterId = "semester-native-invitation-response-0051";
const admissionPeriodId = "admission-period-native-invitation-response-0051";
const fieldOfStudyId = "field-native-invitation-response-0051";
const leaderPersonId = "person-native-invitation-response-leader-0051";
const interviewerPersonId = "person-native-invitation-response-member-0051";
const recruitmentTeamId = "team-native-invitation-response-0051";
const interviewSchemaId = "interview-schema-native-invitation-response-0051";
const invitationCapabilityHeader = "x-recruitment-invitation-capability";

const responseCases = [
  {
    key: "accepted",
    applicantId: "applicant-native-invitation-response-accepted-0051",
    applicationId: "application-native-invitation-response-accepted-0051",
    interviewId: "interview-native-invitation-response-accepted-0051",
    invitationId: "invitation-native-invitation-response-accepted-0051",
    applicantFirstName: "Ada",
    applicantLastName: "Aksept",
    applicantName: "Ada Aksept",
    applicantEmail: "ada.aksept@example.invalid",
    applicantPhone: "90000511",
    scheduledAt: "2031-09-20T13:30:00.000Z",
    room: "R-051A",
    campus: "Gløshaugen",
    mapLink: "https://maps.example.invalid/invitation-response-accepted-0051",
    scheduleMessage: "Vi ser frem til intervjuet.",
    commandPath: "/api/recruitment/invitation-response/confirm",
    finalState: "Accepted",
    responseMessage: null,
    expectedOutboxCount: 0,
  },
  {
    key: "rejected",
    applicantId: "applicant-native-invitation-response-rejected-0051",
    applicationId: "application-native-invitation-response-rejected-0051",
    interviewId: "interview-native-invitation-response-rejected-0051",
    invitationId: "invitation-native-invitation-response-rejected-0051",
    applicantFirstName: "Rita",
    applicantLastName: "Avslag",
    applicantName: "Rita Avslag",
    applicantEmail: "rita.avslag@example.invalid",
    applicantPhone: "90000512",
    scheduledAt: "2031-09-20T14:30:00.000Z",
    room: "R-051B",
    campus: "Gløshaugen",
    mapLink: "https://maps.example.invalid/invitation-response-rejected-0051",
    scheduleMessage: "Vi ser frem til intervjuet.",
    commandPath: "/api/recruitment/invitation-response/reject",
    finalState: "Rejected",
    responseMessage: "Jeg kan ikke delta på dette tidspunktet.",
    expectedOutboxCount: 1,
  },
  {
    key: "requested-new-time",
    applicantId: "applicant-native-invitation-response-requested-new-time-0051",
    applicationId: "application-native-invitation-response-requested-new-time-0051",
    interviewId: "interview-native-invitation-response-requested-new-time-0051",
    invitationId: "invitation-native-invitation-response-requested-new-time-0051",
    applicantFirstName: "Nora",
    applicantLastName: "Ny Tid",
    applicantName: "Nora Ny Tid",
    applicantEmail: "nora.ny.tid@example.invalid",
    applicantPhone: "90000513",
    scheduledAt: "2031-09-20T15:30:00.000Z",
    room: "R-051C",
    campus: "Gløshaugen",
    mapLink: "https://maps.example.invalid/invitation-response-requested-new-time-0051",
    scheduleMessage: "Vi ser frem til intervjuet.",
    commandPath: "/api/recruitment/invitation-response/request-new-time",
    finalState: "RequestedNewTime",
    responseMessage: "Kan vi møtes torsdag i stedet?",
    expectedOutboxCount: 1,
  },
];

const rawCapabilitiesByCase = Object.fromEntries(
  responseCases.map(({ key }) => [
    key,
    createHash("sha256")
      .update(`native-recruitment-invitation-response-capability:${key}:0051`, "utf8")
      .digest("base64url"),
  ]),
);
const rawCapabilities = Object.values(rawCapabilitiesByCase);
if (
  rawCapabilities.length !== 3 ||
  new Set(rawCapabilities).size !== 3 ||
  rawCapabilities.some((capability) => !/^[A-Za-z0-9_-]{43}$/.test(capability))
) {
  throw new Error("Native invitation-response capability generation violated the frozen syntax");
}
const capabilityDigestsByCase = Object.fromEntries(
  responseCases.map(({ key }) => [
    key,
    createHash("sha256").update(rawCapabilitiesByCase[key], "utf8").digest("hex"),
  ]),
);

const journeyEntries = [
  {
    journeyRefId: "intent://journey:recruitment:invitation-response:v1",
    stepIds: [
      "applicant-loads-invitation",
      "applicant-confirms-invitation",
      "applicant-rejects-invitation",
      "applicant-requests-new-time",
      "fresh-applicant-response-read",
      "fresh-leader-response-read",
      "fresh-interviewer-response-read",
      "invalid-response-preserves-state",
      "response-capability-remains-private",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:applicant_notify_self:v1",
    stepIds: [
      "applicant-notify-self-api-operation",
      "applicant-notify-self-command-write",
      "applicant-notify-self-legacy-route",
      "applicant-notify-self-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:interview_candidate:v1",
    stepIds: [
      "interview-candidate-api-operation",
      "interview-candidate-command-write",
      "interview-candidate-legacy-route",
      "interview-candidate-mono-route",
    ],
  },
  {
    journeyRefId: "intent://journey:parity:interview_recruiter:v1",
    stepIds: [
      "interview-recruiter-api-operation",
      "interview-recruiter-command-write",
      "interview-recruiter-legacy-route",
      "interview-recruiter-mono-route",
    ],
  },
];

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
  'admission-period-native-invitation-response-seed-0051'
);
INSERT INTO admission_period_fields_of_study (
  field_of_study_id, department_id, name, active
) VALUES ('${fieldOfStudyId}', '${departmentId}', 'Datateknologi', TRUE);
INSERT INTO admission_applicants (
  applicant_id, normalized_email, email, first_name, last_name, phone,
  gender, field_of_study_id, year_of_study, activation_digest
) VALUES
${responseCases
  .map(
    (entry) =>
      `  ('${entry.applicantId}', '${entry.applicantEmail}', '${entry.applicantEmail}', '${entry.applicantFirstName}', '${entry.applicantLastName}', '${entry.applicantPhone}', 1, '${fieldOfStudyId}', 3, NULL)`,
  )
  .join(",\n")};
INSERT INTO admission_applications (
  application_id, applicant_id, admission_period_id, department_id,
  field_of_study_id, year_of_study, submitted_at, revision
) VALUES
${responseCases
  .map(
    (entry, index) =>
      `  ('${entry.applicationId}', '${entry.applicantId}', '${admissionPeriodId}', '${departmentId}', '${fieldOfStudyId}', 3, '2031-09-${10 + index}T10:00:00.000Z', 0)`,
  )
  .join(",\n")};
INSERT INTO organization_departments (
  department_id, name, short_name, email, city, active, revision
) VALUES (
  '${departmentId}', 'Vektorprogrammet Trondheim', 'Trondheim',
  'trondheim@example.invalid', 'Trondheim', TRUE, 0
);
INSERT INTO person_profiles (person_id, first_name, last_name, revision)
VALUES
  ('${leaderPersonId}', 'Lina', 'Lagleder', 0),
  ('${interviewerPersonId}', 'Irene', 'Intervjuer', 0);
INSERT INTO person_contact_profiles (person_id, email, phone, revision)
VALUES
  ('${leaderPersonId}', 'lina.lagleder@example.invalid', '+47 900 00 511', 0),
  ('${interviewerPersonId}', 'irene.intervjuer@example.invalid', '+47 900 00 512', 0);
INSERT INTO organization_teams (team_id, department_id, name, active, revision)
VALUES ('${recruitmentTeamId}', '${departmentId}', 'Rekruttering', TRUE, 0);
INSERT INTO organization_memberships (
  membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
  position_id, is_team_leader, is_suspended, revision
) VALUES (
  'membership-native-invitation-response-member-0051', '${interviewerPersonId}',
  '${recruitmentTeamId}', NULL, '2031-01-01T00:00:00.000Z', NULL,
  'interviewer', FALSE, FALSE, 0
);
INSERT INTO recruitment_interview_schemas (
  interview_schema_id, name, question_count, active, revision
) VALUES ('${interviewSchemaId}', 'Førstegangsintervju', 8, TRUE, 0);
INSERT INTO recruitment_interviews (
  interview_id, application_id, department_id, interviewer_person_id,
  interview_schema_id, assigned_by_person_id, assigned_at, revision
) VALUES
${responseCases
  .map(
    (entry, index) =>
      `  ('${entry.interviewId}', '${entry.applicationId}', '${departmentId}', '${interviewerPersonId}', '${interviewSchemaId}', '${leaderPersonId}', '2031-09-${12 + index}T09:00:00.000Z', 1)`,
  )
  .join(",\n")};
INSERT INTO recruitment_interview_schedules (
  interview_id, scheduled_at, room, campus, map_link, message,
  scheduled_by_person_id, committed_at, schedule_revision
) VALUES
${responseCases
  .map(
    (entry, index) =>
      `  ('${entry.interviewId}', '${entry.scheduledAt}', '${entry.room}', '${entry.campus}', '${entry.mapLink}', '${entry.scheduleMessage}', '${leaderPersonId}', '2031-09-${12 + index}T09:01:00.000Z', 1)`,
  )
  .join(",\n")};
INSERT INTO recruitment_invitations (
  invitation_id, interview_id, schedule_revision, capability_sha256,
  response_state, created_at
) VALUES
${responseCases
  .map(
    (entry, index) =>
      `  ('${entry.invitationId}', '${entry.interviewId}', 1, '${capabilityDigestsByCase[entry.key]}', 'Pending', '2031-09-${12 + index}T09:02:00.000Z')`,
  )
  .join(",\n")};
COMMIT;
`;

const recordingDriverSource = String.raw`
import { DatabaseLive } from "../database/src/index.js";
import { AdmissionsLive } from "./src/admissions/index.js";
import { OrganizationLive } from "./src/organization/index.js";
import { ProfileLive } from "./src/profile/index.js";
import {
  deliverNextRecruitmentInvitationResponse,
  invitationResponsePayloadForEvidence,
} from "./src/recruitment/index.js";
import { makeRecordingNotificationGateway } from "./src/notification/index.js";
import { Effect, Layer, Redacted } from "effect";

const databaseUrl = process.env.BACKEND_PG_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("BACKEND_PG_URL is required for response recording evidence");
}
const deliveredAt = "2031-09-15T12:01:00.000Z";
const recording = makeRecordingNotificationGateway(deliveredAt);
const databaseLayer = DatabaseLive({
  url: Redacted.make(databaseUrl),
  applicationName: "native-invitation-response-recording-evidence",
  maxConnections: 1,
});
const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));
const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));
const profileLayer = ProfileLive.pipe(
  Layer.provide(Layer.merge(databaseLayer, organizationLayer)),
);
const authorityLayers = Layer.mergeAll(
  databaseLayer,
  admissionsLayer,
  organizationLayer,
  profileLayer,
);

let providerNetworkRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = ((..._arguments: Parameters<typeof fetch>) => {
  providerNetworkRequests += 1;
  return Promise.reject(new Error("The recording NotificationGateway attempted network access"));
}) as typeof fetch;

try {
  const results = [];
  for (let index = 0; index < 2; index += 1) {
    const result = await Effect.runPromise(
      Effect.scoped(
        deliverNextRecruitmentInvitationResponse(
          "native-invitation-response-recording-claim-" + String(index + 1),
          "2031-09-15T12:00:0" + String(index + 1) + ".000Z",
        ).pipe(
          Effect.provide(recording.layer),
          Effect.provide(authorityLayers),
        ),
      ),
    );
    if (result._tag !== "Delivered") {
      throw new Error("Expected a recorded invitation-response delivery");
    }
    results.push({
      result: result._tag,
      claim: {
        effectId: result.claim.effectId,
        claimId: result.claim.claimId,
        attempts: result.claim.attempts,
      },
      notificationEvidence: result.evidence,
    });
  }
  if (recording.responseRequests.length !== 2) {
    throw new Error("Expected exactly two approved response requests");
  }
  if (providerNetworkRequests !== 0) {
    throw new Error("The recording NotificationGateway performed network access");
  }
  const responseRequests = recording.responseRequests.map((request) =>
    JSON.parse(invitationResponsePayloadForEvidence(request)) as unknown,
  );
  process.stdout.write(
    JSON.stringify({ results, responseRequests, providerNetworkRequests }) + "\n",
  );
} finally {
  globalThis.fetch = originalFetch;
}
`;

const dockerAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const postgresTopology = dockerAvailable ? "docker" : "local";
const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const containsRawCapability = (value) =>
  rawCapabilities.some((capability) => value.includes(capability));

function assertNoRawCapability(value, label) {
  const text = Buffer.isBuffer(value)
    ? value.toString("utf8")
    : value instanceof Uint8Array
      ? Buffer.from(value).toString("utf8")
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  if (containsRawCapability(text)) {
    throw new Error(`${label} contained a raw invitation capability`);
  }
}

function makeLeakScanner() {
  let tail = "";
  let leaked = false;
  return {
    observe(chunk) {
      const text = `${tail}${Buffer.from(chunk).toString("utf8")}`;
      if (containsRawCapability(text)) leaked = true;
      tail = text.slice(-42);
    },
    leaked: () => leaked,
  };
}

function boundedFailureDiagnostics(output) {
  const combined = `${output.stdout}\n${output.stderr}`.trim();
  if (combined.length === 0) return "";
  return combined.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(-4_000);
}

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
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const stdout = [];
    const stderr = [];
    const scanner = makeLeakScanner();
    child.stdout.on("data", (chunk) => {
      scanner.observe(chunk);
      if (options.captureOutput === true) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      scanner.observe(chunk);
      if (options.captureOutput === true) stderr.push(chunk);
    });

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
      if (scanner.leaked()) {
        rejectCommand(new Error(`${options.label} emitted a raw invitation capability`));
        return;
      }
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolveCommand(options.captureOutput === true ? output : undefined);
        return;
      }
      const diagnostics = boundedFailureDiagnostics(output);
      rejectCommand(
        new Error(
          `${options.label} exited with ${
            signal === null ? `code ${code}` : `signal ${signal}`
          }${diagnostics.length === 0 ? "" : `\n${diagnostics}`}`,
        ),
      );
    });
  });
}

function startProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const scanner = makeLeakScanner();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    scanner.observe(chunk);
    stdout = `${stdout}${Buffer.from(chunk).toString("utf8")}`.slice(-4_000);
  });
  child.stderr.on("data", (chunk) => {
    scanner.observe(chunk);
    stderr = `${stderr}${Buffer.from(chunk).toString("utf8")}`.slice(-4_000);
  });
  child.once("error", () => undefined);
  child.rawCapabilityObserved = scanner.leaked;
  child.diagnostics = () => (scanner.leaked() ? "" : boundedFailureDiagnostics({ stdout, stderr }));
  return child;
}

function runNixPostgres(command, args, options) {
  return runCommand("nix", ["shell", nixPostgresPackage, "--command", command, ...args], options);
}

function processHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopProcess(child) {
  if (child === undefined || child.pid === undefined || processHasExited(child)) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  if (processHasExited(child)) return;
  signalProcessGroup(child, "SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    sleep(shutdownTimeoutMs).then(() => false),
  ]);
  if (stopped) return;
  signalProcessGroup(child, "SIGKILL");
  const killed = await Promise.race([
    exited.then(() => true),
    sleep(shutdownTimeoutMs).then(() => false),
  ]);
  if (!killed) throw new Error(`Process group ${child.pid} did not exit after SIGKILL`);
}

async function waitForHttp(url, child, label) {
  const deadline = Date.now() + commandTimeoutMs;
  while (Date.now() < deadline) {
    if (processHasExited(child)) throw new Error(`${label} exited before readiness`);
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
        label: "Disposable invitation-response PostgreSQL readiness check",
        captureOutput: true,
      };
      if (postgresTopology === "docker") await runCommand("docker", args, options);
      else await runNixPostgres("pg_isready", args, options);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Disposable invitation-response PostgreSQL did not become ready");
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
      label: "Local invitation-response PostgreSQL initialization",
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
      label: "Local invitation-response PostgreSQL startup",
    },
  );
  await waitForPostgres(environment);
  await runNixPostgres(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local invitation-response PostgreSQL database creation",
    },
  );
}

async function stopLocalPostgres(dataRoot, environment) {
  await runNixPostgres("pg_ctl", ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    label: "Local invitation-response PostgreSQL cleanup",
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

async function startRecordingProxy(targetOrigin, actorsByToken, actorsByCapability) {
  const records = [];
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", targetOrigin).pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBytes = Buffer.concat(chunks);
    const requestJson = parseJsonBody(requestBytes);
    const capabilityHeader = request.headers[invitationCapabilityHeader];
    const capabilityValue = Array.isArray(capabilityHeader)
      ? capabilityHeader[0]
      : capabilityHeader;
    const invitationActor =
      typeof capabilityValue === "string"
        ? (actorsByCapability.get(capabilityValue) ?? null)
        : null;
    const nonCapabilityHeaders = Object.entries(request.headers)
      .filter(([name]) => name !== invitationCapabilityHeader)
      .map(([, value]) => (Array.isArray(value) ? value.join(",") : (value ?? "")))
      .join("\n");
    const record = {
      method,
      path,
      bearerActor: actorsByToken.get(request.headers.authorization ?? "") ?? null,
      invitationActor,
      requestHasInvitationCapability: typeof capabilityValue === "string",
      requestInvitationCapabilityValid:
        typeof capabilityValue === "string" && invitationActor !== null,
      requestHasResponseCapabilityField:
        hasObjectKey(requestJson, "responseCapability") ||
        hasObjectKey(requestJson, "invitationCapability") ||
        hasObjectKey(requestJson, "capability"),
      requestRawCapabilityOutsideDedicatedHeader:
        containsRawCapability(request.url ?? "") ||
        containsRawCapability(requestBytes.toString("utf8")) ||
        containsRawCapability(nonCapabilityHeaders),
      responseHasResponseCapabilityField: false,
      responseRawCapability: false,
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
      const responseHeaders = [...upstream.headers.entries()]
        .filter(([name]) => name !== invitationCapabilityHeader)
        .map(([name, value]) => `${name}:${value}`)
        .join("\n");
      record.status = upstream.status;
      record.responseHasResponseCapabilityField = [
        "responseCapability",
        "invitationCapability",
        "capability",
      ].some((key) => hasObjectKey(responseJson, key));
      record.responseRawCapability =
        containsRawCapability(responseBytes.toString("utf8")) ||
        containsRawCapability(responseHeaders);
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers.entries()) {
        if (["content-encoding", "content-length", "transfer-encoding"].includes(name)) continue;
        response.setHeader(name, value);
      }
      response.setHeader("content-length", String(responseBytes.byteLength));
      response.end(responseBytes);
    } catch {
      record.status = 502;
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end('{"error":"native invitation-response evidence proxy failed"}');
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
    throw new Error("Native invitation-response evidence proxy did not bind a loopback port");
  }
  let closed = false;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
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
  assertNoRawCapability(source, label);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} returned malformed JSON evidence`);
  }
};

async function readJsonFile(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(`${label} is missing`);
  }
  assertNoRawCapability(source, label);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is malformed`);
  }
}

async function readResponseEvidence(environment) {
  const invitationIds = responseCases.map(({ invitationId }) => `'${invitationId}'`).join(", ");
  const result = await runPsql(
    `
      SELECT COALESCE(json_agg(entry ORDER BY ordinal), '[]'::json)::text
      FROM (
        SELECT
          CASE i.invitation_id
            ${responseCases
              .map(({ invitationId }, index) => `WHEN '${invitationId}' THEN ${index}`)
              .join("\n            ")}
            ELSE 99
          END AS ordinal,
          json_build_object(
            'key', CASE i.invitation_id
              ${responseCases
                .map(({ invitationId, key }) => `WHEN '${invitationId}' THEN '${key}'`)
                .join("\n              ")}
              ELSE 'unknown'
            END,
            'invitationId', i.invitation_id,
            'interviewId', i.interview_id,
            'scheduleRevision', i.schedule_revision,
            'interviewRevision', (
              SELECT interview.revision
              FROM recruitment_interviews interview
              WHERE interview.interview_id = i.interview_id
            ),
            'capabilityDigest', i.capability_sha256,
            'responseState', i.response_state,
            'responseMessage', i.response_message,
            'respondedAt', CASE WHEN i.responded_at IS NULL THEN NULL ELSE
              to_char(i.responded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
            'responseRevision', i.response_revision,
            'supersededAt', CASE WHEN i.superseded_at IS NULL THEN NULL ELSE
              to_char(i.superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
            'schedule', (
              SELECT json_build_object(
                'scheduledAt', to_char(s.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'room', s.room,
                'campus', s.campus,
                'mapLink', s.map_link,
                'message', s.message,
                'scheduleRevision', s.schedule_revision
              )
              FROM recruitment_interview_schedules s
              WHERE s.interview_id = i.interview_id
            ),
            'scheduleCount', (
              SELECT count(*) FROM recruitment_interview_schedules s
              WHERE s.interview_id = i.interview_id
            ),
            'audit', (
              SELECT json_build_object(
                'invitationId', a.invitation_id,
                'interviewId', a.interview_id,
                'scheduleRevision', a.schedule_revision,
                'responseRevision', a.response_revision,
                'responseState', a.response_state,
                'responseMessage', a.response_message,
                'respondedAt', to_char(
                  a.responded_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )
              )
              FROM recruitment_invitation_response_audit a
              WHERE a.invitation_id = i.invitation_id
            ),
            'auditCount', (
              SELECT count(*) FROM recruitment_invitation_response_audit a
              WHERE a.invitation_id = i.invitation_id
            ),
            'outbox', COALESCE((
              SELECT json_agg(json_build_object(
                'effectId', o.effect_id,
                'effectType', o.effect_type,
                'invitationId', o.invitation_id,
                'interviewId', o.interview_id,
                'scheduleRevision', o.schedule_revision,
                'responseRevision', o.response_revision,
                'responseState', o.response_state,
                'responseMessage', o.response_message,
                'ordinal', o.ordinal,
                'status', o.status,
                'attempts', o.attempts,
                'claimCleared', o.claim_id IS NULL AND o.claimed_at IS NULL,
                'deliveredAt', CASE WHEN o.delivered_at IS NULL THEN NULL ELSE
                  to_char(o.delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
              ) ORDER BY o.effect_id)
              FROM recruitment_invitation_response_outbox o
              WHERE o.invitation_id = i.invitation_id
            ), '[]'::json)
          ) AS entry
        FROM recruitment_invitations i
        WHERE i.invitation_id IN (${invitationIds})
      ) response_rows;
    `,
    environment,
    "Native invitation-response PostgreSQL evidence read",
  );
  return parseJsonOutput(result, "Native invitation-response PostgreSQL evidence read");
}

async function assertCanonicalDatabasePrivacy(environment) {
  const result = await runPsql(
    `
      SELECT json_build_object(
        'invitations', COALESCE((SELECT json_agg(to_jsonb(row)) FROM recruitment_invitations row), '[]'::json),
        'schedules', COALESCE((SELECT json_agg(to_jsonb(row)) FROM recruitment_interview_schedules row), '[]'::json),
        'responseAudit', COALESCE((SELECT json_agg(to_jsonb(row)) FROM recruitment_invitation_response_audit row), '[]'::json),
        'responseOutbox', COALESCE((SELECT json_agg(to_jsonb(row)) FROM recruitment_invitation_response_outbox row), '[]'::json)
      )::text;
    `,
    environment,
    "Canonical invitation-response privacy read",
  );
  assertNoRawCapability(result.stdout, "Canonical PostgreSQL rows");
}

const assertEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not match the frozen native invitation-response journey`);
  }
};

function assertSeedEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length !== responseCases.length) {
    throw new Error("PostgreSQL seed did not contain three complete invitation graphs");
  }
  for (const responseCase of responseCases) {
    const row = evidence.find(({ key }) => key === responseCase.key);
    if (
      row?.invitationId !== responseCase.invitationId ||
      row?.interviewId !== responseCase.interviewId ||
      row?.scheduleRevision !== 1 ||
      row?.interviewRevision !== 1 ||
      row?.capabilityDigest !== capabilityDigestsByCase[responseCase.key] ||
      row?.responseState !== "Pending" ||
      row?.responseMessage !== null ||
      row?.respondedAt !== null ||
      row?.responseRevision !== 0 ||
      row?.supersededAt !== null ||
      row?.scheduleCount !== 1 ||
      row?.auditCount !== 0 ||
      row?.audit !== null ||
      !Array.isArray(row?.outbox) ||
      row.outbox.length !== 0
    ) {
      throw new Error("A seeded invitation was not a complete Pending authority graph");
    }
    assertEqual(
      row.schedule,
      {
        scheduledAt: responseCase.scheduledAt,
        room: responseCase.room,
        campus: responseCase.campus,
        mapLink: responseCase.mapLink,
        message: responseCase.scheduleMessage,
        scheduleRevision: 1,
      },
      `Seeded schedule ${responseCase.key}`,
    );
  }
}

function assertCommittedEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length !== responseCases.length) {
    throw new Error("Committed PostgreSQL response evidence was incomplete");
  }
  for (const responseCase of responseCases) {
    const row = evidence.find(({ key }) => key === responseCase.key);
    if (
      row?.invitationId !== responseCase.invitationId ||
      row?.interviewId !== responseCase.interviewId ||
      row?.scheduleRevision !== 1 ||
      row?.interviewRevision !== 1 ||
      row?.capabilityDigest !== capabilityDigestsByCase[responseCase.key] ||
      row?.responseState !== responseCase.finalState ||
      row?.responseMessage !== responseCase.responseMessage ||
      row?.respondedAt !== fixedClock ||
      row?.responseRevision !== 1 ||
      row?.supersededAt !== null ||
      row?.scheduleCount !== 1 ||
      row?.auditCount !== 1 ||
      row?.audit?.invitationId !== responseCase.invitationId ||
      row?.audit?.interviewId !== responseCase.interviewId ||
      row?.audit?.scheduleRevision !== 1 ||
      row?.audit?.responseRevision !== 1 ||
      row?.audit?.responseState !== responseCase.finalState ||
      row?.audit?.responseMessage !== responseCase.responseMessage ||
      row?.audit?.respondedAt !== fixedClock ||
      !Array.isArray(row?.outbox) ||
      row.outbox.length !== responseCase.expectedOutboxCount ||
      row.outbox.some(
        (entry) =>
          entry.effectId !== `recruitment-invitation-response:${responseCase.invitationId}:1` ||
          entry.effectType !== "SendInterviewInvitationResponse" ||
          entry.invitationId !== responseCase.invitationId ||
          entry.interviewId !== responseCase.interviewId ||
          entry.scheduleRevision !== 1 ||
          entry.responseRevision !== 1 ||
          entry.responseState !== responseCase.finalState ||
          entry.responseMessage !== responseCase.responseMessage ||
          entry.ordinal !== 0 ||
          entry.status !== "Pending" ||
          entry.attempts !== 0 ||
          entry.claimCleared !== true ||
          entry.deliveredAt !== null,
      )
    ) {
      throw new Error("Committed response, audit, or outbox evidence violated atomic state laws");
    }
    assertEqual(
      row.schedule,
      {
        scheduledAt: responseCase.scheduledAt,
        room: responseCase.room,
        campus: responseCase.campus,
        mapLink: responseCase.mapLink,
        message: responseCase.scheduleMessage,
        scheduleRevision: 1,
      },
      `Retained schedule ${responseCase.key}`,
    );
  }
}

function assertDeliveredEvidence(evidence, committedEvidence) {
  if (!Array.isArray(evidence) || evidence.length !== responseCases.length) {
    throw new Error("Post-interpretation PostgreSQL evidence was incomplete");
  }
  for (const responseCase of responseCases) {
    const before = committedEvidence.find(({ key }) => key === responseCase.key);
    const after = evidence.find(({ key }) => key === responseCase.key);
    if (
      after?.invitationId !== responseCase.invitationId ||
      after?.interviewId !== responseCase.interviewId ||
      after?.scheduleRevision !== 1 ||
      after?.interviewRevision !== 1 ||
      after?.capabilityDigest !== capabilityDigestsByCase[responseCase.key] ||
      after?.responseState !== responseCase.finalState ||
      after?.responseMessage !== responseCase.responseMessage ||
      after?.respondedAt !== fixedClock ||
      after?.responseRevision !== 1 ||
      after?.supersededAt !== null ||
      after?.auditCount !== 1 ||
      JSON.stringify(after?.audit) !== JSON.stringify(before?.audit) ||
      after?.scheduleCount !== 1 ||
      !Array.isArray(after?.outbox) ||
      after.outbox.length !== responseCase.expectedOutboxCount
    ) {
      throw new Error("Response interpretation changed authoritative response or schedule state");
    }
    if (responseCase.expectedOutboxCount === 1) {
      const delivery = after.outbox[0];
      if (
        delivery?.effectId !== `recruitment-invitation-response:${responseCase.invitationId}:1` ||
        delivery?.effectType !== "SendInterviewInvitationResponse" ||
        delivery?.invitationId !== responseCase.invitationId ||
        delivery?.interviewId !== responseCase.interviewId ||
        delivery?.scheduleRevision !== 1 ||
        delivery?.responseRevision !== 1 ||
        delivery?.responseState !== responseCase.finalState ||
        delivery?.responseMessage !== responseCase.responseMessage ||
        delivery?.ordinal !== 0 ||
        delivery?.status !== "Delivered" ||
        delivery?.attempts !== 1 ||
        delivery?.claimCleared !== true ||
        delivery?.deliveredAt !== responseDeliveredAt
      ) {
        throw new Error("Approved response notification did not reach Delivered database state");
      }
    }
    assertEqual(after.schedule, before?.schedule, `Post-delivery schedule ${responseCase.key}`);
  }
}

function assertBrowserEvidence(browser) {
  const expectedOperations = [
    { actor: "Applicant:accepted", operation: "readInvitationResponse" },
    { actor: "Applicant:rejected", operation: "readInvitationResponse" },
    { actor: "Applicant:accepted", operation: "confirmInvitation" },
    { actor: "Applicant:accepted", operation: "readInvitationResponse" },
    { actor: "Applicant:accepted", operation: "confirmInvitation" },
    { actor: "Applicant:accepted", operation: "readInvitationResponse" },
    { actor: "Applicant:rejected", operation: "rejectInvitation" },
    { actor: "Applicant:rejected", operation: "readInvitationResponse" },
    { actor: "Applicant:rejected", operation: "rejectInvitation" },
    { actor: "Applicant:rejected", operation: "readInvitationResponse" },
    { actor: "Applicant:requested-new-time", operation: "readInvitationResponse" },
    { actor: "Applicant:requested-new-time", operation: "requestNewInvitationTime" },
    { actor: "Applicant:requested-new-time", operation: "readInvitationResponse" },
    { actor: "Applicant:requested-new-time", operation: "requestNewInvitationTime" },
    { actor: "Applicant:requested-new-time", operation: "readInvitationResponse" },
    { actor: "Applicant:requested-new-time", operation: "requestNewInvitationTime" },
    { actor: "Applicant:requested-new-time", operation: "readInvitationResponse" },
    { actor: "DepartmentLeader", operation: "readSchedulingBoard" },
    { actor: "Member", operation: "readSchedulingBoard" },
  ];
  if (
    browser?.topology !== "native-postgresql-foldkit-chromium" ||
    browser?.applicantContexts?.isolatedFromStaff !== true ||
    browser?.applicantContexts?.sharedTabContext !== true ||
    browser?.applicantContexts?.closed !== 2 ||
    browser?.tabBinding?.sameBrowserContext !== true ||
    browser?.tabBinding?.exchangedTabs !== 2 ||
    browser?.tabBinding?.distinctInteractionIds !== true ||
    browser?.tabBinding?.distinctCookieNames !== true ||
    browser?.tabBinding?.invalidExchangeStatus !== 404 ||
    browser?.tabBinding?.invalidExchangePreservedBindings !== true ||
    browser?.staffContexts?.independent !== true ||
    browser?.staffContexts?.closed !== 2 ||
    browser?.capabilityExchangeRequests !== 3 ||
    browser?.operationOrderingConfirmed !== true ||
    browser?.accessibilityViolations !== 0 ||
    browser?.legacyBrowserRequests !== 0 ||
    browser?.externalBrowserRequests !== 0 ||
    browser?.providerBrowserRequests !== 0 ||
    browser?.pageErrors !== 0 ||
    browser?.consoleErrors !== 0 ||
    browser?.rawCapabilityObservedOutsideExchange !== false ||
    browser?.rawCapabilitySerialized !== false ||
    JSON.stringify(browser?.bridgeOperations) !== JSON.stringify(expectedOperations) ||
    !Array.isArray(browser?.applicantCases) ||
    browser.applicantCases.length !== 3
  ) {
    throw new Error(
      "Browser evidence did not prove the complete native invitation-response journey",
    );
  }
  const accepted = browser.applicantCases.find(({ key }) => key === "accepted");
  const rejected = browser.applicantCases.find(({ key }) => key === "rejected");
  const requested = browser.applicantCases.find(({ key }) => key === "requested-new-time");
  for (const [entry, state] of [
    [accepted, "Accepted"],
    [rejected, "Rejected"],
    [requested, "RequestedNewTime"],
  ]) {
    if (
      entry?.initialState !== "Pending" ||
      entry?.initialReadStatus !== 200 ||
      entry?.commandStatus !== 204 ||
      entry?.commandResultUsedAsObservation !== false ||
      entry?.freshReadStatus !== 200 ||
      entry?.finalState !== state ||
      entry?.repeatedStatus !== 409 ||
      entry?.repeatedFreshReadStatus !== 200 ||
      entry?.repeatedState !== state ||
      entry?.scheduleRetained !== true ||
      entry?.redactedUrl !== true ||
      entry?.cookie?.httpOnly !== true ||
      entry?.cookie?.sameSite !== "Strict" ||
      entry?.cookie?.path !== "/interview" ||
      entry?.cookie?.session !== true ||
      entry?.cookie?.valueMatchesExchange !== true ||
      entry?.cookie?.interactionBound !== true
    ) {
      throw new Error("An applicant browser context did not prove fresh-read response semantics");
    }
  }
  if (
    requested?.invalidBlank?.clientCommandBlocked !== true ||
    requested?.invalidBlank?.bridgeStatus !== 422 ||
    requested?.invalidBlank?.freshReadStatus !== 200 ||
    requested?.invalidBlank?.preservedState !== "Pending" ||
    requested?.capabilityShapedMessage?.clientCommandBlocked !== true ||
    requested?.capabilityShapedMessage?.bridgeFetchAttempted !== false ||
    requested?.capabilityShapedMessage?.preservedState !== "Pending" ||
    browser?.staffContexts?.observations?.DepartmentLeader?.freshReadStatus !== 200 ||
    browser?.staffContexts?.observations?.DepartmentLeader?.acceptedVisible !== true ||
    browser?.staffContexts?.observations?.DepartmentLeader?.requestedNewTimeVisible !== true ||
    browser?.staffContexts?.observations?.DepartmentLeader?.responseMessagesProjected !== true ||
    browser?.staffContexts?.observations?.DepartmentLeader?.rejectedVisible !== true ||
    browser?.staffContexts?.observations?.Member?.freshReadStatus !== 200 ||
    browser?.staffContexts?.observations?.Member?.acceptedVisible !== true ||
    browser?.staffContexts?.observations?.Member?.requestedNewTimeVisible !== true ||
    browser?.staffContexts?.observations?.Member?.responseMessagesProjected !== true ||
    browser?.staffContexts?.observations?.Member?.rejectedVisible !== false
  ) {
    throw new Error("Invalid preservation or staff projection evidence was incomplete");
  }
}

function assertNativeTransport(records) {
  const readPath = "/api/recruitment/invitation-response";
  const boardPath = "/api/admin/recruitment/interviews/scheduling-board";
  const profilePath = "/api/me";
  const expected = [
    { method: "GET", path: readPath, status: 200, invitationActor: "accepted", bearerActor: null },
    { method: "GET", path: readPath, status: 200, invitationActor: "accepted", bearerActor: null },
    { method: "GET", path: readPath, status: 200, invitationActor: "rejected", bearerActor: null },
    { method: "GET", path: readPath, status: 200, invitationActor: "rejected", bearerActor: null },
    {
      method: "POST",
      path: responseCases[0].commandPath,
      status: 204,
      invitationActor: "accepted",
      bearerActor: null,
    },
    { method: "GET", path: readPath, status: 200, invitationActor: "accepted", bearerActor: null },
    {
      method: "POST",
      path: responseCases[0].commandPath,
      status: 409,
      invitationActor: "accepted",
      bearerActor: null,
    },
    { method: "GET", path: readPath, status: 200, invitationActor: "accepted", bearerActor: null },
    {
      method: "POST",
      path: responseCases[1].commandPath,
      status: 204,
      invitationActor: "rejected",
      bearerActor: null,
    },
    { method: "GET", path: readPath, status: 200, invitationActor: "rejected", bearerActor: null },
    {
      method: "POST",
      path: responseCases[1].commandPath,
      status: 409,
      invitationActor: "rejected",
      bearerActor: null,
    },
    { method: "GET", path: readPath, status: 200, invitationActor: "rejected", bearerActor: null },
    {
      method: "GET",
      path: readPath,
      status: 200,
      invitationActor: "requested-new-time",
      bearerActor: null,
    },
    {
      method: "GET",
      path: readPath,
      status: 200,
      invitationActor: "requested-new-time",
      bearerActor: null,
    },
    {
      method: "GET",
      path: readPath,
      status: 200,
      invitationActor: "requested-new-time",
      bearerActor: null,
    },
    {
      method: "POST",
      path: responseCases[2].commandPath,
      status: 204,
      invitationActor: "requested-new-time",
      bearerActor: null,
    },
    {
      method: "GET",
      path: readPath,
      status: 200,
      invitationActor: "requested-new-time",
      bearerActor: null,
    },
    {
      method: "POST",
      path: responseCases[2].commandPath,
      status: 409,
      invitationActor: "requested-new-time",
      bearerActor: null,
    },
    {
      method: "GET",
      path: readPath,
      status: 200,
      invitationActor: "requested-new-time",
      bearerActor: null,
    },
    {
      method: "GET",
      path: profilePath,
      status: 200,
      invitationActor: null,
      bearerActor: "DepartmentLeader",
    },
    {
      method: "GET",
      path: boardPath,
      status: 200,
      invitationActor: null,
      bearerActor: "DepartmentLeader",
    },
    {
      method: "GET",
      path: boardPath,
      status: 200,
      invitationActor: null,
      bearerActor: "DepartmentLeader",
    },
    { method: "GET", path: profilePath, status: 200, invitationActor: null, bearerActor: "Member" },
    { method: "GET", path: boardPath, status: 200, invitationActor: null, bearerActor: "Member" },
    { method: "GET", path: boardPath, status: 200, invitationActor: null, bearerActor: "Member" },
  ];
  assertEqual(
    records.map(({ method, path, status, invitationActor, bearerActor }) => ({
      method,
      path,
      status,
      invitationActor,
      bearerActor,
    })),
    expected,
    "Native invitation-response transport order",
  );
  const allowedPaths = new Set([
    readPath,
    profilePath,
    boardPath,
    ...responseCases.map(({ commandPath }) => commandPath),
  ]);
  if (
    records.some(
      (record) =>
        !allowedPaths.has(record.path) ||
        record.requestHasResponseCapabilityField ||
        record.responseHasResponseCapabilityField ||
        record.requestRawCapabilityOutsideDedicatedHeader ||
        record.responseRawCapability ||
        (record.invitationActor !== null &&
          (!record.requestHasInvitationCapability ||
            !record.requestInvitationCapabilityValid ||
            record.bearerActor !== null)) ||
        (record.bearerActor !== null && record.requestHasInvitationCapability),
    )
  ) {
    throw new Error("Native transport exposed capability data or crossed an authority boundary");
  }
}

function assertRecordingEvidence(recording, committedEvidence, deliveredEvidence) {
  if (
    recording?.providerNetworkRequests !== 0 ||
    !Array.isArray(recording?.results) ||
    recording.results.length !== 2 ||
    recording.results.some(
      (result) =>
        result?.result !== "Delivered" ||
        result?.claim?.attempts !== 1 ||
        typeof result?.claim?.effectId !== "string" ||
        result.claim.effectId.length === 0 ||
        result?.notificationEvidence?.effectId !== result?.claim?.effectId,
    ) ||
    !Array.isArray(recording?.responseRequests) ||
    recording.responseRequests.length !== 2
  ) {
    throw new Error("Recording NotificationGateway response evidence was incomplete");
  }
  const expectedNotificationCases = responseCases.filter(
    ({ expectedOutboxCount }) => expectedOutboxCount === 1,
  );
  for (const responseCase of expectedNotificationCases) {
    const request = recording.responseRequests.find(
      (candidate) => candidate?.responseState === responseCase.finalState,
    );
    if (
      request?._tag !== "SendInterviewInvitationResponse" ||
      request?.effectId !== `recruitment-invitation-response:${responseCase.invitationId}:1` ||
      request?.invitationId !== responseCase.invitationId ||
      request?.interviewId !== responseCase.interviewId ||
      request?.scheduleRevision !== 1 ||
      request?.responseRevision !== 1 ||
      request?.applicantDisplayName !== responseCase.applicantName ||
      request?.scheduledAt !== responseCase.scheduledAt ||
      request?.responseState !== responseCase.finalState ||
      request?.responseMessage !== responseCase.responseMessage ||
      request?.interviewerEmail !== "irene.intervjuer@example.invalid" ||
      request?.interviewerPhone !== "+47 900 00 512"
    ) {
      throw new Error(
        "Recording gateway did not observe an approved response notification request",
      );
    }
    const before = committedEvidence.find(({ key }) => key === responseCase.key);
    const after = deliveredEvidence.find(({ key }) => key === responseCase.key);
    if (
      !before?.outbox?.some(({ effectId }) => effectId === request.effectId) ||
      !after?.outbox?.some(
        ({ effectId, status }) => effectId === request.effectId && status === "Delivered",
      )
    ) {
      throw new Error("Recording response request did not identify its delivered database effect");
    }
  }
  assertEqual(
    recording.results.map(({ claim }) => claim.effectId).sort(),
    recording.responseRequests.map(({ effectId }) => effectId).sort(),
    "Recorded response delivery effects",
  );
}

const receiptRequested = () =>
  [
    "RUNTIME_EVIDENCE_RECEIPT_PATH",
    "RUNTIME_EVIDENCE_LEGACY_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_MONO_REVISION_REF_ID",
    "RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS",
  ].some((name) => typeof process.env[name] === "string" && process.env[name].length > 0);

async function prepareReceiptInputs(playwrightOutput) {
  if (!receiptRequested()) return undefined;
  const sourceRefIds = (process.env.RUNTIME_EVIDENCE_RUNNER_SOURCE_REF_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const sourcePaths = [runnerPath, specPath];
  if (sourceRefIds.length === 0 || sourceRefIds.length > sourcePaths.length) {
    throw new Error(
      "Native invitation-response evidence expects one or two runner source references",
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
    Buffer.from("\n-- native response recording driver --\n", "utf8"),
    Buffer.from(recordingDriverSource, "utf8"),
  ]);
  const artifactBytes = sanitizePlaywrightArtifact(Buffer.from(playwrightOutput, "utf8"));
  for (const input of runnerSourceInputBytes) {
    assertNoRawCapability(input.bytes, "Runtime evidence runner source input");
  }
  assertNoRawCapability(fixtureInputBytes, "Runtime evidence fixture input");
  assertNoRawCapability(artifactBytes, "Sanitized Playwright artifact");
  return { runnerSourceInputBytes, fixtureInputBytes, artifactBytes };
}

async function emitReceipts(inputs) {
  if (inputs === undefined) return;
  await emitRuntimeEvidenceReceipts({
    journeys: journeyEntries,
    fixtureId: "native-recruitment-invitation-response-0051",
    runnerSourceInputBytes: inputs.runnerSourceInputBytes,
    fixtureInputBytes: inputs.fixtureInputBytes,
    artifactBytes: inputs.artifactBytes,
  });
}

async function main() {
  assertNoRawCapability(seedSql, "PostgreSQL seed SQL");
  assertNoRawCapability(recordingDriverSource, "Recording driver source");
  await Promise.all([
    assertPortAvailable(dashboardPort),
    assertPortAvailable(backendPort),
    assertPortAvailable(postgresPort),
  ]);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-native-invitation-response-0051-"));
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const stagingRoot = join(temporaryRoot, "receipt-staging");
  const committedRoot = join(temporaryRoot, "receipt-committed");
  const browserEvidencePath = join(temporaryRoot, "browser-evidence.json");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(committedRoot, { recursive: true }),
  ]);

  const leaderToken = randomBytes(32).toString("base64url");
  const memberToken = randomBytes(32).toString("base64url");
  const admissionTokens = JSON.stringify({
    [leaderToken]: {
      _tag: "DepartmentLeader",
      personId: leaderPersonId,
      departmentId,
      active: true,
    },
    [memberToken]: {
      _tag: "Member",
      personId: interviewerPersonId,
      departmentId,
      active: true,
    },
  });
  const receiptPrincipal = (personId) => ({
    personId,
    departmentId,
    active: true,
    paymentAccountCiphertext: randomBytes(32).toString("base64url"),
    approvalScope: { _tag: "None" },
  });
  const receiptTokens = JSON.stringify({
    [leaderToken]: receiptPrincipal(leaderPersonId),
    [memberToken]: receiptPrincipal(interviewerPersonId),
  });
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;
  delete baseEnvironment.ALCHEMY_CLOUDFLARE_VITE_INJECTED;
  const apiEnvironment = {
    ...baseEnvironment,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: postgresUrl,
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    ADMISSION_AUTH_TOKENS: admissionTokens,
    ORGANIZATION_AUTH_TOKENS:
      '{"inert-organization-token":{"_tag":"OrganizationMember","personId":"person-inert-organization-runner"}}',
    ADMISSION_FIXED_NOW: fixedClock,
    RECEIPT_AUTH_TOKENS: receiptTokens,
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
  let receiptInputs;
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
              label: "Disposable invitation-response PostgreSQL cleanup",
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
      throw new AggregateError(cleanupErrors, "Native invitation-response topology cleanup failed");
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
          label: "Disposable invitation-response PostgreSQL startup",
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
    await runPsql(seedSql, baseEnvironment, "Native invitation-response fixture seed");
    const seededEvidence = await readResponseEvidence(baseEnvironment);
    assertSeedEvidence(seededEvidence);
    await assertCanonicalDatabasePrivacy(baseEnvironment);

    proxy = await startRecordingProxy(
      backendOrigin,
      new Map([
        [`Bearer ${leaderToken}`, "DepartmentLeader"],
        [`Bearer ${memberToken}`, "Member"],
      ]),
      new Map(responseCases.map(({ key }) => [rawCapabilitiesByCase[key], key])),
    );
    const dashboardEnvironment = {
      ...baseEnvironment,
      API_URL: proxy.origin,
      VITE_API_URL: proxy.origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      REAL_NATIVE_INVITATION_RESPONSE_E2E: "1",
      NODE_ENV: "development",
      TZ: "Europe/Oslo",
      HOST: "127.0.0.1",
      PORT: String(dashboardPort),
    };
    const playwrightEnvironment = {
      ...dashboardEnvironment,
      INVITATION_RESPONSE_E2E_ACCEPTED_CAPABILITY: rawCapabilitiesByCase.accepted,
      INVITATION_RESPONSE_E2E_REJECTED_CAPABILITY: rawCapabilitiesByCase.rejected,
      INVITATION_RESPONSE_E2E_REQUESTED_NEW_TIME_CAPABILITY:
        rawCapabilitiesByCase["requested-new-time"],
      INVITATION_RESPONSE_E2E_LEADER_TOKEN: leaderToken,
      INVITATION_RESPONSE_E2E_MEMBER_TOKEN: memberToken,
      INVITATION_RESPONSE_E2E_BROWSER_EVIDENCE_PATH: browserEvidencePath,
    };

    await runCommand("bun", ["run", "build"], {
      cwd: sdkRoot,
      env: dashboardEnvironment,
      label: "Native invitation-response SDK build",
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
      { cwd: dashboardRoot, env: dashboardEnvironment },
    );
    await waitForHttp(
      `${dashboardOrigin}/interview-response/redacted`,
      dashboardProcess,
      "Dashboard",
    );

    const playwrightArgs = [
      "./node_modules/@playwright/test/cli.js",
      "test",
      "e2e/real-interview-response.spec.ts",
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
        env: playwrightEnvironment,
        label: "Native recruitment invitation-response Playwright journey",
        captureOutput: true,
      },
    );
    assertNoRawCapability(playwright.stdout, "Playwright reporter output");
    assertNoRawCapability(playwright.stderr, "Playwright diagnostic output");
    const browser = await readJsonFile(
      browserEvidencePath,
      "Native invitation-response browser evidence",
    );
    assertBrowserEvidence(browser);
    assertNativeTransport(proxy.records);
    if (apiProcess.rawCapabilityObserved() || dashboardProcess.rawCapabilityObserved()) {
      throw new Error("A native process log contained a raw invitation capability");
    }

    const committedEvidence = await readResponseEvidence(baseEnvironment);
    assertCommittedEvidence(committedEvidence);
    await assertCanonicalDatabasePrivacy(baseEnvironment);
    const recordingResult = await runCommand("bun", ["--eval", recordingDriverSource], {
      cwd: domainRoot,
      env: { ...baseEnvironment, BACKEND_PG_URL: postgresUrl },
      label: "Recording invitation-response NotificationGateway interpreter",
      captureOutput: true,
    });
    const recording = parseJsonOutput(
      recordingResult,
      "Recording invitation-response NotificationGateway interpreter",
    );
    const deliveredEvidence = await readResponseEvidence(baseEnvironment);
    assertDeliveredEvidence(deliveredEvidence, committedEvidence);
    assertRecordingEvidence(recording, committedEvidence, deliveredEvidence);
    await assertCanonicalDatabasePrivacy(baseEnvironment);
    receiptInputs = await prepareReceiptInputs(playwright.stdout);

    evidence = {
      topology: {
        dashboard: "loopback-react-router-playwright-server",
        api: "unified-native-effect-backend",
        database:
          postgresTopology === "docker"
            ? "disposable-postgresql-docker"
            : "disposable-postgresql-local-nix",
        browser: "real-chromium",
        notification: "recording-gateway-fetch-blocked",
        fixedClock,
      },
      browser,
      nativeTransport: {
        records: proxy.records.map(({ method, path, status, bearerActor, invitationActor }) => ({
          method,
          path,
          status,
          bearerActor,
          invitationActor,
        })),
        operationOrderingConfirmed: true,
        legacyRequests: 0,
        externalRequests: 0,
        providerRequests: 0,
        rawCapabilityObserved: false,
      },
      postgres: {
        seeded: seededEvidence,
        committed: committedEvidence,
        afterRecordingInterpretation: deliveredEvidence,
        invalidAndRepeatedCommandsPreservedCounts: true,
        canonicalRowsScannedForCapabilities: true,
      },
      recording: {
        ...recording,
        interpretationKind: "recording-gateway-only",
        providerDeliveryProved: false,
      },
      receipts: {
        journeyRefIds: journeyEntries.map(({ journeyRefId }) => journeyRefId),
        exactStepIds: journeyEntries.map(({ journeyRefId, stepIds }) => ({
          journeyRefId,
          stepIds,
        })),
        sanitizedReporter: true,
        sanitizedFixtureInputs: true,
      },
    };
    assertNoRawCapability(evidence, "Final native invitation-response evidence");
  } catch (error) {
    const transportDiagnostics =
      proxy === undefined
        ? ""
        : JSON.stringify(
            proxy.records.map(({ method, path, status, bearerActor, invitationActor }) => ({
              method,
              path,
              status,
              bearerActor,
              invitationActor,
            })),
          );
    const processDiagnostics = [
      ["backend", apiProcess?.diagnostics?.()],
      ["dashboard", dashboardProcess?.diagnostics?.()],
      ["transport", transportDiagnostics],
    ]
      .filter(([, diagnostics]) => typeof diagnostics === "string" && diagnostics.length > 0)
      .map(([label, diagnostics]) => `${label}:\n${diagnostics}`)
      .join("\n");
    primaryError =
      processDiagnostics.length === 0
        ? error
        : new Error(
            `${error instanceof Error ? error.message : String(error)}\n${processDiagnostics}`,
          );
  }

  const releasedPorts = [dashboardPort, backendPort, postgresPort];
  if (proxy?.port !== undefined) releasedPorts.push(proxy.port);
  let cleanupError;
  try {
    await cleanup();
    if (await pathExists(temporaryRoot)) {
      throw new Error("Native invitation-response cleanup left the temporary root behind");
    }
    await Promise.all(releasedPorts.map((port) => waitForPortRelease(port)));
    if (
      apiProcess?.rawCapabilityObserved?.() === true ||
      dashboardProcess?.rawCapabilityObserved?.() === true
    ) {
      throw new Error("A released native process log contained a raw invitation capability");
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTermination);
  }

  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Native invitation-response journey and cleanup failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;

  await emitReceipts(receiptInputs);
  const finalEvidence = {
    ...evidence,
    cleanup: {
      postgresRemoved: true,
      temporaryRootRemoved: true,
      portsReleased: releasedPorts,
    },
  };
  const serializedEvidence = `${JSON.stringify(finalEvidence)}\n`;
  assertNoRawCapability(serializedEvidence, "Printed native invitation-response evidence");
  process.stdout.write(serializedEvidence);
}

const errorDetail = (error) =>
  error instanceof AggregateError
    ? `${error.message}: ${error.errors.map(errorDetail).join("; ")}`
    : error instanceof Error
      ? error.message
      : String(error);

main().catch((error) => {
  const detail = errorDetail(error);
  process.stderr.write(
    `Real native recruitment invitation-response runner failed: ${
      containsRawCapability(detail) ? "private failure detail redacted" : detail
    }\n`,
  );
  process.exitCode = 1;
});
