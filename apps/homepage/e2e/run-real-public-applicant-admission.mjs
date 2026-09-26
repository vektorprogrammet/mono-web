import { postgresProgram, startDisposablePostgres } from "@monoweb/postgres";
import {
  AdmissionPeriodManagementItem,
  AdmissionsSubmitApplicationProblem,
} from "@vektorprogrammet/http-api";
import { Predicate, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { reserveLoopbackPorts } from "../../../tools/e2e/golden-harness.ts";
import { localBackendEnvironment } from "../../../tools/e2e/local-backend-environment.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const homepageRoot = fileURLToPath(new URL("../", import.meta.url));

const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));

const homepageDevVarsPath = join(homepageRoot, ".dev.vars");

const [postgresPort, backendPort, homepagePort, staffPort] = await reserveLoopbackPorts(4);

const homepageHost = "p000.vektor.phibkro.org";

/** The browser loads this loopback origin and sends the homepage Host on every request. */
const homepageOrigin = `http://127.0.0.1:${homepagePort}`;

const backendOrigin = `http://127.0.0.1:${backendPort}`;

/** The first-party origin that native identity trusts for staff requests; nothing listens there. */
const staffOrigin = `http://127.0.0.1:${staffPort}`;

const postgresUrl = `postgres://receipt:receipt@127.0.0.1:${postgresPort}/receipt_proof?connect_timeout=1`;

const commandTimeoutMs = 300_000;

const shutdownTimeoutMs = 5_000;

/**
 * Only GitHub Actions with PUBLIC_APPLICATION_REMOTE_EVIDENCE=1 writes the evidence file
 * that the workflow uploads. Every other run proves the same journey and prints it.
 */
const remoteEvidenceAuthorized =
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.PUBLIC_APPLICATION_REMOTE_EVIDENCE === "1";

/**
 * A session is valid only while it outlives the authorization instant, and new sessions
 * expire days after real time, so the fixed admission clock lies in the past.
 */
const fixedClock = "2025-09-15T12:00:00.000Z";

const departmentId = "department-trondheim";

const foreignDepartmentId = "department-bergen";

const semesterId = "semester-autumn-2025";

const fieldOfStudyId = "field-mathematics";

const inactiveFieldOfStudyId = "field-inactive";

const foreignFieldOfStudyId = "field-foreign";

const openStart = "2025-09-01T08:00:00.000Z";

const openEnd = "2025-10-01T20:00:00.000Z";

const closedEnd = "2025-09-10T12:00:00.000Z";

/** The department leader who opens the period and later closes it. */
const leader = {
  personId: "leader-trondheim-0039",
  firstName: "Lise",
  lastName: "Leder",
  email: "leader-trondheim-0039@example.invalid",
  password: randomBytes(24).toString("base64url"),
};

const betterAuthSecret = randomBytes(32).toString("base64url");

const privateCanaries = [
  "Applicant Canary",
  "Private Surname",
  "applicant-canary-0039@example.invalid",
  "+47 900 00 039",
];

const secretCanaries = ["receipt:receipt", leader.password, betterAuthSecret];

const commandProcesses = new Set();

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

const decodeStrict = (schema) => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

function assertPortAvailable(port) {
  return new Promise((resolvePort, rejectPort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      rejectPort(new Error(`Loopback port ${port} is already in use`));
    });
    socket.once("error", (error) => {
      socket.destroy();

      if (Predicate.hasProperty(error, "code") && error.code === "ECONNREFUSED") {
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
      detached: true,
    });

    commandProcesses.add(child);
    const stdout = [];
    const stderr = [];

    if (captureOutput) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }

    let settled = false;

    const timeout = setTimeout(() => {
      void stopProcess(child).catch(() => undefined);

      if (!settled) {
        settled = true;
        rejectCommand(new Error(`${options.label} timed out`));
      }
    }, commandTimeoutMs);

    timeout.unref();

    child.once("error", () => {
      commandProcesses.delete(child);

      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectCommand(new Error(`${options.label} could not start`));
    });
    child.once("close", (code, signal) => {
      commandProcesses.delete(child);

      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolveCommand(
          captureOutput ? { stdout: Buffer.concat(stdout).toString("utf8") } : undefined,
        );

        return;
      }

      const diagnostics = captureOutput ? `\n${Buffer.concat(stderr).toString("utf8")}` : "";

      rejectCommand(
        new Error(
          `${options.label} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}${diagnostics}`,
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
    if (!Predicate.hasProperty(error, "code") || error.code !== "ESRCH") {
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
    if (!Predicate.hasProperty(error, "code") || error.code !== "ESRCH") {
      throw new Error("Could not terminate local process group");
    }
  }

  await exited;
}

/** One HTTP status, or 0 when nothing answered; node:http can send the homepage Host. */
function probeHttp(url, headers) {
  return new Promise((resolveProbe) => {
    const probe = httpRequest(url, { headers }, (response) => {
      response.resume();
      resolveProbe(response.statusCode ?? 0);
    });

    probe.once("error", () => resolveProbe(0));
    probe.end();
  });
}

async function waitForHttp(url, child, label, headers = {}) {
  const deadline = Date.now() + commandTimeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before readiness`);
    }

    if ((await probeHttp(url, headers)) === 200) return;

    await sleep(250);
  }

  throw new Error(`${label} did not become ready`);
}

async function pathExists(path) {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function runPsql(sql, environment, label) {
  return runCommand(
    postgresProgram("psql"),
    [
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
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      label,
      captureOutput: true,
    },
  );
}

/** Creates the login of the department leader; the seed applies every migration first. */
async function seedLeaderIdentity(environment) {
  await runCommand("bun", ["run", "identity:seed"], {
    cwd: databaseRoot,
    env: {
      ...environment,
      IDENTITY_SEED_PG_URL: postgresUrl,
      IDENTITY_SEED_PERSONS: JSON.stringify([leader]),
    },
    label: "Public-application leader identity seed",
    captureOutput: true,
  });
}

async function seedReferenceData(environment) {
  await runPsql(
    `
      INSERT INTO admission_period_departments (department_id, name)
      VALUES
        ('${departmentId}', 'Trondheim'),
        ('${foreignDepartmentId}', 'Bergen');
      INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
      VALUES (
        '${semesterId}',
        '2025-08-01T00:00:00.000Z',
        '2025-12-31T00:00:00.000Z'
      );
      INSERT INTO admission_period_fields_of_study (
        field_of_study_id,
        department_id,
        name,
        active
      ) VALUES
        ('${fieldOfStudyId}', '${departmentId}', 'Matematikk', TRUE),
        ('${inactiveFieldOfStudyId}', '${departmentId}', 'Inaktiv linje', FALSE),
        ('${foreignFieldOfStudyId}', '${foreignDepartmentId}', 'Fysikk', TRUE);
      INSERT INTO organization_departments (department_id, name, short_name, email, city, independent)
      VALUES ('${departmentId}', 'Trondheim', 'TRD', 'trondheim-0039@example.invalid', 'Trondheim', TRUE);
      -- Styret is the department's board of an independent department, so its leader reaches
      -- the department and creates its admission period (O8-11).
      INSERT INTO organization_teams (team_id, department_id, name, kind)
      VALUES ('team-trondheim-board-0039', '${departmentId}', 'Styret', 'DepartmentBoard');
      INSERT INTO organization_memberships (
        membership_id,
        person_id,
        team_id,
        start_at,
        position_id,
        is_team_leader
      ) VALUES (
        'membership-leader-trondheim-0039',
        '${leader.personId}',
        'team-trondheim-board-0039',
        '2020-01-01T00:00:00.000Z',
        'leader',
        TRUE
      );
    `,
    environment,
    "Public-application reference-data seed",
  );
}

/** Signs the leader in through Better Auth and returns the session cookies. */
async function signInLeader() {
  const response = await fetch(`${backendOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: staffOrigin },
    body: JSON.stringify({ email: leader.email, password: leader.password }),
  });

  if (response.status !== 200) {
    throw new Error(`Leader sign-in answered ${response.status}`);
  }

  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0])
    .join("; ");

  if (!cookie.includes("better-auth.session_token=")) {
    throw new Error("Leader sign-in set no session cookie");
  }

  return cookie;
}

async function createOpenPeriod(leaderCookie) {
  const response = await fetch(`${backendOrigin}/api/admission-periods`, {
    method: "POST",
    headers: {
      cookie: leaderCookie,
      origin: staffOrigin,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ semesterId, startAt: openStart, endAt: openEnd, departmentId }),
  });

  if (response.status !== 201) {
    throw new Error(`Admission period creation answered ${response.status}`);
  }

  const period = decodeStrict(AdmissionPeriodManagementItem)(await response.json());

  if (
    period.departmentId !== departmentId ||
    period.semesterId !== semesterId ||
    period.startAt !== openStart ||
    period.endAt !== openEnd ||
    response.headers.get("etag") !== period.etag
  ) {
    throw new Error("Admission period creation returned another period");
  }

  return period;
}

async function runOutboxDelivery(environment) {
  const result = await runCommand(
    "bun",
    ["run", "tools/e2e/public-application-outbox-driver.ts"],
    {
      cwd: repositoryRoot,
      env: {
        ...environment,
        PUBLIC_APPLICATION_OUTBOX_PG_URL: postgresUrl,
      },
      label: "Recording-only public-application outbox delivery",
      captureOutput: true,
    },
  );

  return JSON.parse(result.stdout.trim());
}

async function readPostgresEvidence(environment) {
  const result = await runPsql(
    `
      SELECT json_build_object(
        'applicantCount', (SELECT count(*) FROM admission_applicants),
        'applicationCount', (SELECT count(*) FROM admission_applications),
        'commandCount', (
          SELECT count(*) FROM admission_application_command_receipts
        ),
        'auditCount', (SELECT count(*) FROM admission_application_audit),
        'outboxCount', (SELECT count(*) FROM admission_application_outbox),
        'duplicateEffectCount', (
          SELECT count(*) FROM (
            SELECT effect_id
            FROM admission_application_outbox
            GROUP BY effect_id
            HAVING count(*) > 1
          ) duplicate_effects
        ),
        'normalizedIdentityCount', (
          SELECT count(DISTINCT normalized_email) FROM admission_applicants
        ),
        'primaryProfilePreserved', EXISTS (
          SELECT 1
          FROM admission_applicants
          WHERE normalized_email = 'applicant-canary-0039@example.invalid'
            AND first_name = 'Applicant Canary'
            AND last_name = 'Private Surname'
            AND phone = '+47 900 00 039'
            AND gender = 0
            AND field_of_study_id = '${fieldOfStudyId}'
            AND year_of_study = 3
        ),
        'applicants', COALESCE((
          SELECT json_agg(json_build_object(
            'applicantId', applicant_id,
            'fieldOfStudyId', field_of_study_id,
            'yearOfStudy', year_of_study,
            'activationDigestPresent', activation_digest IS NOT NULL
          ) ORDER BY applicant_id)
          FROM admission_applicants
        ), '[]'::json),
        'applications', COALESCE((
          SELECT json_agg(json_build_object(
            'applicationId', application_id,
            'applicantId', applicant_id,
            'admissionPeriodId', admission_period_id,
            'departmentId', department_id,
            'fieldOfStudyId', field_of_study_id,
            'yearOfStudy', year_of_study,
            'revision', revision,
            'availability', json_build_object(
              'mondayUnavailable', monday_unavailable,
              'tuesdayUnavailable', tuesday_unavailable,
              'wednesdayUnavailable', wednesday_unavailable,
              'thursdayUnavailable', thursday_unavailable,
              'fridayUnavailable', friday_unavailable,
              'positionWeeks', position_weeks,
              'preferredGroup', preferred_group,
              'language', language
            )
          ) ORDER BY application_id)
          FROM admission_applications
        ), '[]'::json),
        'commands', COALESCE((
          SELECT json_agg(json_build_object(
            'commandId', command_id,
            'applicationId', application_id
          ) ORDER BY command_id)
          FROM admission_application_command_receipts
        ), '[]'::json),
        'audits', COALESCE((
          SELECT json_agg(json_build_object(
            'commandId', command_id,
            'applicationId', application_id,
            'applicantId', applicant_id,
            'action', action,
            'revision', application_revision
          ) ORDER BY command_id)
          FROM admission_application_audit
        ), '[]'::json),
        'outbox', COALESCE((
          SELECT json_agg(json_build_object(
            'effectId', effect_id,
            'effectType', effect_type,
            'applicationId', application_id,
            'commandId', command_id,
            'ordinal', ordinal,
            'status', status,
            'attempts', attempts,
            'lastFailureTag', last_failure_tag
          ) ORDER BY application_id, ordinal)
          FROM admission_application_outbox
        ), '[]'::json)
      )::text;
    `,
    environment,
    "Public-application persistence evidence query",
  );

  return JSON.parse(result.stdout.trim());
}

function assertDurableEvidence(postgres, lifecycle, delivery, persistenceFailure) {
  const expectedKinds = [
    "SendApplicantActivationOrConfirmation",
    "CreateAdmissionSubscription",
    "WriteApplicationAudit",
  ];

  const applicationIds = postgres.applications.map((application) => application.applicationId);
  const outboxByApplication = Object.groupBy(postgres.outbox, (effect) => effect.applicationId);
  const auditCommandIds = postgres.audits.map((audit) => audit.commandId);
  const commandIds = postgres.commands.map((command) => command.commandId);

  const commandApplicationIds = postgres.commands
    .map((command) => command.applicationId)
    .toSorted()
    .join(",");

  if (
    postgres.applicantCount !== 2 ||
    postgres.applicationCount !== 2 ||
    postgres.commandCount !== 2 ||
    postgres.auditCount !== 2 ||
    postgres.outboxCount !== 6 ||
    postgres.duplicateEffectCount !== 0 ||
    postgres.normalizedIdentityCount !== 2 ||
    postgres.primaryProfilePreserved !== true ||
    !applicationIds.includes(lifecycle.browser.applicationId) ||
    !applicationIds.includes(lifecycle.concurrent.acceptedApplicationId) ||
    commandApplicationIds !== applicationIds.toSorted().join(",") ||
    lifecycle.replay.sameApplicationId !== true ||
    lifecycle.browser.draftPreservedAfterDuplicate !== true ||
    lifecycle.browser.axe.formSeriousCritical !== 0 ||
    lifecycle.browser.axe.errorSeriousCritical !== 0 ||
    lifecycle.browser.axe.confirmationSeriousCritical !== 0 ||
    lifecycle.closing.confirmationPreserved !== true ||
    lifecycle.closing.rejection.code !== "application.no-eligible-period" ||
    lifecycle.concurrent.rejected.code !== "application.duplicate" ||
    lifecycle.rejections.duplicate.code !== "application.duplicate" ||
    lifecycle.rejections.replayConflict.code !== "idempotency.digest-conflict" ||
    lifecycle.rejections.rateLimited?.code !== "rate-limit.exceeded" ||
    lifecycle.rejections.bodyLimit.code !== "request.too-large" ||
    persistenceFailure.code !== "idempotency.unavailable" ||
    postgres.audits.some(
      (audit) =>
        audit.action !== "PublicApplicationSubmitted" ||
        audit.revision !== 0 ||
        !commandIds.includes(audit.commandId),
    ) ||
    commandIds.some((commandId) => !auditCommandIds.includes(commandId)) ||
    postgres.outbox.some(
      (effect) => effect.status !== "Delivered" || effect.lastFailureTag !== null,
    ) ||
    delivery.appliedEffectIds.length !== 6 ||
    new Set(delivery.appliedEffectIds).size !== 6
  ) {
    throw new Error(
      "Public-application persistence evidence did not prove the frozen journey laws",
    );
  }

  const browserApplication = postgres.applications.find(
    (application) => application.applicationId === lifecycle.browser.applicationId,
  );

  if (!isDeepStrictEqual(browserApplication?.availability, lifecycle.browser.availability)) {
    throw new Error("The browser application did not store the availability that it stated");
  }

  for (const applicationId of applicationIds) {
    const effects = outboxByApplication[applicationId] ?? [];

    if (
      effects.map((effect) => effect.effectType).join(",") !== expectedKinds.join(",") ||
      effects.map((effect) => effect.ordinal).join(",") !== "0,1,2"
    ) {
      throw new Error("Public-application effects were not delivered in order");
    }
  }

  const retried = postgres.outbox.find((effect) => effect.effectId === delivery.retriedEffectId);

  if (
    retried?.attempts !== 2 ||
    delivery.injectedFailureTag !== "PublicApplicationEffectDeliveryError" ||
    delivery.duplicateProviderApplyCount !== 0 ||
    delivery.duplicateProviderDeliveryCount !== 1
  ) {
    throw new Error("Public-application outbox retry evidence was incomplete");
  }
}

/**
 * Without PostgreSQL the command cannot open its receipt transaction. The request states the
 * browser application's availability, so only the outage can reject it.
 */
async function exercisePostgresFailure(postgres, availability) {
  const response = await postgres.outage(() =>
    fetch(`${backendOrigin}/api/applications`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({
        departmentId,
        firstName: "Persistence Failure",
        lastName: "Canary",
        phone: "+47 933 33 333",
        email: "persistence-failure-0039@example.invalid",
        gender: 1,
        fieldOfStudyId,
        yearOfStudy: 4,
        availability,
      }),
    }),
  );

  if (
    response.status !== 503 ||
    response.headers.get("content-type") !== "application/problem+json" ||
    response.headers.get("retry-after") !== "5"
  ) {
    throw new Error(`PostgreSQL failure answered ${response.status} instead of a 503 problem`);
  }

  const problem = decodeStrict(AdmissionsSubmitApplicationProblem)(await response.json());

  if (problem.code !== "idempotency.unavailable") {
    throw new Error(`PostgreSQL failure answered ${problem.code}`);
  }

  return { status: response.status, code: problem.code };
}

function startBackend(environment) {
  const configuredBackendCommand = process.env.BACKEND_COMMAND;

  return configuredBackendCommand
    ? startProcess("/bin/sh", ["-c", configuredBackendCommand], {
        cwd: repositoryRoot,
        env: environment,
      })
    : startProcess("bun", ["run", "--cwd", "apps/backend", "start"], {
        cwd: repositoryRoot,
        env: environment,
      });
}

async function main() {
  const evidencePath = process.env.PUBLIC_APPLICATION_EVIDENCE_PATH;

  if (remoteEvidenceAuthorized && !evidencePath) {
    throw new Error("PUBLIC_APPLICATION_EVIDENCE_PATH is required for remote evidence");
  }

  if (!remoteEvidenceAuthorized && evidencePath !== undefined) {
    throw new Error(
      "PUBLIC_APPLICATION_EVIDENCE_PATH is written only in GitHub Actions with PUBLIC_APPLICATION_REMOTE_EVIDENCE=1",
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-public-application-0039-"));
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const lifecycleEvidencePath = join(temporaryRoot, "public-application-lifecycle.json");

  const baseEnvironment = { ...process.env };

  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;
  delete baseEnvironment.API_URL;
  delete baseEnvironment.VITE_API_URL;

  const apiEnvironment = {
    ...baseEnvironment,
    ...localBackendEnvironment({
      backendOrigin,
      dashboardOrigin: staffOrigin,
      postgresUrl,
      betterAuthSecret,
    }),
    ADMISSION_FIXED_NOW: fixedClock,
    ADMISSION_MAX_BODY_BYTES: "16384",
    ADMISSION_RATE_LIMIT_MAX: "64",
    ADMISSION_RATE_LIMIT_WINDOW_MS: "600000",
  };

  const homepageEnvironment = {
    ...baseEnvironment,
    API_URL: backendOrigin,
  };

  let postgres;
  let devVarsCreated = false;
  let apiProcess;
  let homepageProcess;
  let evidence;
  let leaderCookie;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const cleanupErrors = [];

    for (const processToStop of [...commandProcesses, homepageProcess, apiProcess]) {
      try {
        await stopProcess(processToStop);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (devVarsCreated) {
      try {
        await rm(homepageDevVarsPath, { force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      await postgres?.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }

    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Public-application topology cleanup failed");
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
    postgres = await startDisposablePostgres({
      user: "receipt",
      database: "receipt_proof",
      port: postgresPort,
      directory: postgresDataRoot,
    });

    await seedLeaderIdentity(apiEnvironment);
    await seedReferenceData(baseEnvironment);

    apiProcess = startBackend(apiEnvironment);
    await waitForHttp(`${backendOrigin}/health`, apiProcess, "Unified native backend");
    leaderCookie = await signInLeader();
    const period = await createOpenPeriod(leaderCookie);

    // The build copies .dev.vars into its output, where the preview reads API_URL. Git
    // ignores the file, so the bundle build still sees a clean worktree.
    await writeFile(homepageDevVarsPath, `API_URL=${backendOrigin}\n`, { flag: "wx", mode: 0o600 });
    devVarsCreated = true;
    await runCommand("bun", ["run", "worker:build"], {
      cwd: homepageRoot,
      env: homepageEnvironment,
      label: "Public-application homepage build",
    });
    homepageProcess = startProcess(
      "bunx",
      ["vite", "preview", "--host", "127.0.0.1", "--port", String(homepagePort), "--strictPort"],
      { cwd: homepageRoot, env: homepageEnvironment },
    );
    await waitForHttp(`${homepageOrigin}/health`, homepageProcess, "Homepage", {
      host: homepageHost,
    });

    const playwrightEnvironment = {
      ...homepageEnvironment,
      REAL_PUBLIC_APPLICATION_E2E: "1",
      HOMEPAGE_ORIGIN: homepageOrigin,
      BACKEND_ORIGIN: backendOrigin,
      PUBLIC_APPLICATION_E2E_EVIDENCE_PATH: lifecycleEvidencePath,
      PUBLIC_APPLICATION_E2E_PERIOD_ID: period.id,
      PUBLIC_APPLICATION_E2E_PERIOD_ETAG: period.etag,
      PUBLIC_APPLICATION_E2E_PERIOD_REVISION: String(period.revision),
      PUBLIC_APPLICATION_E2E_OPEN_END: openEnd,
      PUBLIC_APPLICATION_E2E_CLOSED_END: closedEnd,
      PUBLIC_APPLICATION_E2E_LEADER_COOKIE: leaderCookie,
      PUBLIC_APPLICATION_E2E_STAFF_ORIGIN: staffOrigin,
      PUBLIC_APPLICATION_E2E_RATE_LIMIT_ATTEMPTS: "80",
      PUBLIC_APPLICATION_PLAYWRIGHT_ARTIFACT_ROOT: join(temporaryRoot, "playwright"),
    };

    await runCommand(
      "node",
      [
        "./node_modules/@playwright/test/cli.js",
        "test",
        "e2e/public-applicant-admission.spec.ts",
        "--project=chromium",
        "--workers=1",
        "--retries=0",
      ],
      {
        cwd: homepageRoot,
        env: playwrightEnvironment,
        label: "Real public-applicant Playwright journey",
      },
    );

    const lifecycle = JSON.parse(await readFile(lifecycleEvidencePath, "utf8"));
    const delivery = await runOutboxDelivery(baseEnvironment);
    const postgresBeforeFailure = await readPostgresEvidence(baseEnvironment);

    // A fresh backend has a fresh public rate limit for the failure request.
    await stopProcess(apiProcess);
    apiProcess = startBackend(apiEnvironment);
    await waitForHttp(`${backendOrigin}/health`, apiProcess, "Restarted unified backend");

    const persistenceFailure = await exercisePostgresFailure(
      postgres,
      lifecycle.browser.availability,
    );

    const postgresAfterFailure = await readPostgresEvidence(baseEnvironment);

    if (JSON.stringify(postgresBeforeFailure) !== JSON.stringify(postgresAfterFailure)) {
      throw new Error("PostgreSQL rejection mutated public-application state");
    }

    assertDurableEvidence(postgresAfterFailure, lifecycle, delivery, persistenceFailure);

    evidence = {
      topology: {
        mode: remoteEvidenceAuthorized ? "remote-ci" : "local",
        homepage: "loopback-built-cloudflare-worker-preview",
        api: "unified-native-effect-backend",
        database: "disposable-postgresql-local",
        browser: "real-chromium-single-worker",
        effects: "recording-only-bounded-outbox",
        fixedClock,
      },
      postgres: postgresAfterFailure,
      lifecycle,
      delivery,
      persistenceFailure,
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
      "Public-application journey and cleanup failed",
    );
  }

  if (primaryError !== undefined) throw primaryError;

  if (cleanupError !== undefined) throw cleanupError;

  if ((await pathExists(temporaryRoot)) || (await pathExists(homepageDevVarsPath))) {
    throw new Error("Public-application cleanup left temporary files behind");
  }

  const releasedPorts = [postgresPort, backendPort, homepagePort];
  await Promise.all(releasedPorts.map(assertPortAvailable));

  const finalEvidence = {
    ...evidence,
    cleanup: {
      postgresRemoved: true,
      temporaryRootRemoved: true,
      portsReleased: releasedPorts,
    },
  };

  const serializedEvidence = JSON.stringify(finalEvidence);

  for (const canary of [...privateCanaries, ...secretCanaries, leaderCookie]) {
    if (serializedEvidence.includes(canary)) {
      throw new Error("Public-application evidence exposed private material");
    }
  }

  if (remoteEvidenceAuthorized) {
    await writeFile(evidencePath, `${serializedEvidence}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  process.stdout.write(`${serializedEvidence}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Real public-application runner failed"}\n`,
  );

  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  }

  process.exitCode = 1;
});
