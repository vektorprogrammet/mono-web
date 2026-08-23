import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const homepageRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const composeFile = join(repositoryRoot, "docker-compose.yml");
const homepageOrigin = "http://127.0.0.1:8787";
const homepageHost = "p000.vektor.phibkro.org";
const backendOrigin = "http://127.0.0.1:8792";
const postgresUrl = "postgres://receipt:receipt@127.0.0.1:55432/receipt_proof?connect_timeout=1";
const composeProject = `mono-web-public-application-0039-${process.pid}`;
const commandTimeoutMs = 300_000;
const shutdownTimeoutMs = 5_000;
const postgresPort = 55432;
const nixPostgresPackage = "nixpkgs#postgresql_17";
const remoteEvidenceAuthorized =
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.PUBLIC_APPLICATION_REMOTE_EVIDENCE === "1";
const fixedClock = "2031-09-15T12:00:00.000Z";
const departmentId = "department-trondheim";
const foreignDepartmentId = "department-bergen";
const semesterId = "semester-autumn-2031";
const fieldOfStudyId = "field-mathematics";
const inactiveFieldOfStudyId = "field-inactive";
const foreignFieldOfStudyId = "field-foreign";
const openStart = "2031-09-01T08:00:00.000Z";
const openEnd = "2031-10-01T20:00:00.000Z";
const privateCanaries = [
  "Applicant Canary",
  "Private Surname",
  "applicant-canary-0039@example.invalid",
  "+47 900 00 039",
];
const secretCanaries = ["receipt:receipt"];
const postgresTopology = "docker";
const commandProcesses = new Set();

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
      detached: true,
    });
    commandProcesses.add(child);
    const stdout = [];
    if (captureOutput) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.resume();
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
      rejectCommand(
        new Error(
          `${options.label} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}`,
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

async function waitForHttp(url, child, label, init = undefined) {
  const deadline = Date.now() + commandTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before readiness`);
    }
    try {
      const response = await fetch(url, { ...init, redirect: "manual" });
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
        label: "Disposable public-application PostgreSQL readiness check",
        captureOutput: true,
      };
      if (postgresTopology === "docker") {
        await runCommand("docker", args, options);
      } else {
        await runNixPostgres("pg_isready", args, options);
      }
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Disposable public-application PostgreSQL did not become ready");
}

async function initializeLocalPostgres(dataRoot, environment) {
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
      label: "Local public-application PostgreSQL initialization",
    },
  );
  await startExistingLocalPostgres(dataRoot, environment);
  await runNixPostgres(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "receipt", "receipt_proof"],
    {
      cwd: repositoryRoot,
      env: environment,
      label: "Local public-application PostgreSQL database creation",
    },
  );
}

async function startExistingLocalPostgres(dataRoot, environment) {
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
      label: "Local public-application PostgreSQL startup",
    },
  );
  await waitForPostgres(environment);
}

async function stopLocalPostgres(dataRoot, environment) {
  await runNixPostgres("pg_ctl", ["-D", dataRoot, "-m", "fast", "-w", "stop"], {
    cwd: repositoryRoot,
    env: environment,
    label: "Local public-application PostgreSQL stop",
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
        '2031-08-01T00:00:00.000Z',
        '2031-12-31T00:00:00.000Z'
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
    `,
    environment,
    "Public-application reference-data seed",
  );
}

async function createOpenPeriod(leaderToken) {
  const response = await fetch(`${backendOrigin}/api/admin/admission-periods`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${leaderToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      commandId: "open-public-application-period-0039",
      semesterId,
      startAt: openStart,
      endAt: openEnd,
    }),
  });
  if (!response.ok) {
    throw new Error("Could not create the public-application admission period");
  }
  const observation = await response.json();
  if (
    !observation ||
    typeof observation !== "object" ||
    observation._tag !== "Created" ||
    !observation.period ||
    typeof observation.period.id !== "string"
  ) {
    throw new Error("Admission period creation returned an invalid observation");
  }
  return observation.period.id;
}

async function runOutboxDelivery(environment) {
  const result = await runCommand(
    "bun",
    ["run", "apps/homepage/e2e/public-application-outbox-driver.ts"],
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
            'revision', revision
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
    !commandIds.includes(lifecycle.browser.commandId) ||
    lifecycle.replay.sameApplicationId !== true ||
    lifecycle.browser.draftPreservedAfterDuplicate !== true ||
    lifecycle.browser.axe.formSeriousCritical !== 0 ||
    lifecycle.browser.axe.errorSeriousCritical !== 0 ||
    lifecycle.browser.axe.confirmationSeriousCritical !== 0 ||
    lifecycle.closing.confirmationPreserved !== true ||
    lifecycle.closing.rejection.tag !== "NoEligibleAdmissionPeriod" ||
    lifecycle.concurrent.rejected.tag !== "DuplicatePublicApplication" ||
    lifecycle.rejections.duplicate.tag !== "DuplicatePublicApplication" ||
    lifecycle.rejections.replayConflict.tag !== "DuplicatePublicApplicationCommandConflict" ||
    lifecycle.rejections.rateLimited.tag !== "PublicApplicationRateLimitExceeded" ||
    lifecycle.rejections.bodyLimit.tag !== "RequestBodyTooLarge" ||
    persistenceFailure.tag !== "PublicApplicationPersistenceError" ||
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

async function stopPostgres(dataRoot, environment) {
  if (postgresTopology === "docker") {
    await runCommand(
      "docker",
      ["compose", "-f", composeFile, "-p", composeProject, "stop", "receipt-postgres"],
      {
        cwd: repositoryRoot,
        env: environment,
        label: "Disposable PostgreSQL failure injection",
      },
    );
  } else {
    await stopLocalPostgres(dataRoot, environment);
  }
}

async function restartPostgres(dataRoot, environment) {
  if (postgresTopology === "docker") {
    await runCommand(
      "docker",
      ["compose", "-f", composeFile, "-p", composeProject, "start", "receipt-postgres"],
      {
        cwd: repositoryRoot,
        env: environment,
        label: "Disposable PostgreSQL restart",
      },
    );
    await waitForPostgres(environment);
  } else {
    await startExistingLocalPostgres(dataRoot, environment);
  }
}

async function exercisePostgresFailure(dataRoot, environment) {
  await stopPostgres(dataRoot, environment);
  let response;
  try {
    response = await fetch(`${backendOrigin}/api/applications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "postgres-failure-public-application-0039",
        departmentId,
        firstName: "Persistence Failure",
        lastName: "Canary",
        phone: "+47 933 33 333",
        email: "persistence-failure-0039@example.invalid",
        gender: 1,
        fieldOfStudyId,
        yearOfStudy: 4,
      }),
    });
  } finally {
    await restartPostgres(dataRoot, environment);
  }
  if (response.status !== 503) {
    throw new Error("PostgreSQL failure did not return a typed service rejection");
  }
  const body = await response.json();
  if (body?.error?.tag !== "PublicApplicationPersistenceError") {
    throw new Error("PostgreSQL failure returned an unexpected error tag");
  }
  return { status: response.status, tag: body.error.tag };
}

async function main() {
  if (!remoteEvidenceAuthorized) {
    throw new Error("The real public-applicant journey is authorized only in isolated remote CI");
  }
  if (!process.env.PUBLIC_APPLICATION_EVIDENCE_PATH) {
    throw new Error("PUBLIC_APPLICATION_EVIDENCE_PATH is required");
  }
  if (postgresTopology !== "docker") {
    throw new Error("Isolated remote CI requires Docker-backed disposable PostgreSQL");
  }
  await Promise.all([
    assertPortAvailable(8787),
    assertPortAvailable(8792),
    assertPortAvailable(postgresPort),
  ]);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-web-public-application-0039-"));
  const postgresDataRoot = join(temporaryRoot, "postgres");
  const lifecycleEvidencePath = join(temporaryRoot, "public-application-lifecycle.json");
  const leaderToken = randomBytes(32).toString("base64url");
  const admissionTokens = JSON.stringify({
    [leaderToken]: {
      _tag: "DepartmentLeader",
      personId: "leader-trondheim",
      departmentId,
      active: true,
    },
  });
  const receiptTokens = JSON.stringify({
    [leaderToken]: {
      personId: "leader-trondheim",
      departmentId,
      active: true,
      paymentAccountCiphertext: randomBytes(32).toString("base64url"),
      approvalScope: { _tag: "None" },
    },
  });
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.API_MODE;
  delete baseEnvironment.VITE_API_MODE;
  delete baseEnvironment.API_URL;
  delete baseEnvironment.VITE_API_URL;

  const apiEnvironment = {
    ...baseEnvironment,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: "8792",
    BACKEND_PG_URL: postgresUrl,
    ADMISSION_AUTH_TOKENS: admissionTokens,
    ADMISSION_FIXED_NOW: fixedClock,
    ADMISSION_MAX_BODY_BYTES: "16384",
    ADMISSION_RATE_LIMIT_MAX: "64",
    ADMISSION_RATE_LIMIT_WINDOW_MS: "600000",
    RECEIPT_AUTH_TOKENS: receiptTokens,
  };
  const homepageEnvironment = {
    ...baseEnvironment,
    API_URL: backendOrigin,
  };

  let postgresStarted = false;
  let apiProcess;
  let homepageProcess;
  let evidence;
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
              label: "Disposable public-application PostgreSQL cleanup",
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
    postgresStarted = true;
    if (postgresTopology === "docker") {
      await runCommand(
        "docker",
        ["compose", "-f", composeFile, "-p", composeProject, "up", "-d", "receipt-postgres"],
        {
          cwd: repositoryRoot,
          env: baseEnvironment,
          label: "Disposable public-application PostgreSQL startup",
        },
      );
      await waitForPostgres(baseEnvironment);
    } else {
      await initializeLocalPostgres(postgresDataRoot, baseEnvironment);
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
    await seedReferenceData(baseEnvironment);
    const admissionPeriodId = await createOpenPeriod(leaderToken);

    await runCommand("bun", ["run", "build"], {
      cwd: sdkRoot,
      env: homepageEnvironment,
      label: "Public-application SDK build",
    });
    await runCommand("bun", ["run", "worker:build"], {
      cwd: homepageRoot,
      env: homepageEnvironment,
      label: "Public-application homepage build",
    });
    homepageProcess = startProcess("bun", ["run", "worker:dev"], {
      cwd: homepageRoot,
      env: homepageEnvironment,
    });
    await waitForHttp(`${homepageOrigin}/health`, homepageProcess, "Homepage", {
      headers: { host: homepageHost },
    });

    const playwrightEnvironment = {
      ...homepageEnvironment,
      REAL_PUBLIC_APPLICATION_E2E: "1",
      HOMEPAGE_ORIGIN: homepageOrigin,
      BACKEND_ORIGIN: backendOrigin,
      PUBLIC_APPLICATION_E2E_EVIDENCE_PATH: lifecycleEvidencePath,
      PUBLIC_APPLICATION_E2E_PERIOD_ID: admissionPeriodId,
      PUBLIC_APPLICATION_E2E_LEADER_TOKEN: leaderToken,
      PUBLIC_APPLICATION_E2E_RATE_LIMIT_ATTEMPTS: "80",
    };
    playwrightEnvironment.PUBLIC_APPLICATION_PLAYWRIGHT_ARTIFACT_ROOT = join(
      temporaryRoot,
      "playwright",
    );
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

    await stopProcess(apiProcess);
    apiProcess = configuredBackendCommand
      ? startProcess("/bin/sh", ["-c", configuredBackendCommand], {
          cwd: repositoryRoot,
          env: apiEnvironment,
        })
      : startProcess("bun", ["run", "--cwd", "apps/backend", "start"], {
          cwd: repositoryRoot,
          env: apiEnvironment,
        });
    await waitForHttp(`${backendOrigin}/health`, apiProcess, "Restarted unified backend");
    const persistenceFailure = await exercisePostgresFailure(postgresDataRoot, baseEnvironment);
    const postgresAfterFailure = await readPostgresEvidence(baseEnvironment);
    if (JSON.stringify(postgresBeforeFailure) !== JSON.stringify(postgresAfterFailure)) {
      throw new Error("PostgreSQL rejection mutated public-application state");
    }
    assertDurableEvidence(postgresAfterFailure, lifecycle, delivery, persistenceFailure);

    evidence = {
      topology: {
        homepage: "loopback-built-cloudflare-worker-preview",
        api: "unified-native-effect-backend",
        database:
          postgresTopology === "docker"
            ? "disposable-postgresql-docker"
            : "disposable-postgresql-local-nix",
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

  if (await pathExists(temporaryRoot)) {
    throw new Error("Public-application cleanup left the temporary root behind");
  }
  await Promise.all([
    assertPortAvailable(8787),
    assertPortAvailable(8792),
    assertPortAvailable(postgresPort),
  ]);

  const finalEvidence = {
    ...evidence,
    cleanup: {
      postgresRemoved: true,
      temporaryRootRemoved: true,
      portsReleased: [8787, 8792, postgresPort],
    },
  };
  const serializedEvidence = JSON.stringify(finalEvidence);
  for (const canary of [...privateCanaries, ...secretCanaries, leaderToken]) {
    if (serializedEvidence.includes(canary)) {
      throw new Error("Public-application evidence exposed private material");
    }
  }
  await writeFile(process.env.PUBLIC_APPLICATION_EVIDENCE_PATH, `${serializedEvidence}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${serializedEvidence}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Real public-application runner failed"}\n`,
  );
  process.exitCode = 1;
});
