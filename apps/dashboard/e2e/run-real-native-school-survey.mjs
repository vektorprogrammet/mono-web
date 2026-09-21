import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import pg from "pg";
import apexWorker from "../../../infra/alchemy/preview/apex-worker.ts";
import { APEX_IDENTITY } from "../../../infra/alchemy/preview/identity.ts";
import { schoolSurveyIdFromPathSegment, schoolSurveyPath } from "../app/lib/school-survey-path.ts";
import { handleDashboardWorkerRequest } from "../workers/dashboard-worker.ts";

const { Client } = pg;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const backendRoot = fileURLToPath(new URL("../../backend/", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const runnerPath = fileURLToPath(import.meta.url);
const specPath = join(repositoryRoot, "design-specs/0111-native-school-survey-participation.md");
const manifestPath =
  process.env.SCHOOL_SURVEY_EVIDENCE_MANIFEST_PATH ??
  join(repositoryRoot, "evidence/functional-parity/0111/acceptance-manifest.json");
const postgresPort = 45370;
const backendPort = 45371;
const proxyPort = 45372;
const dashboardPort = 5174;
const apexPort = 45373;
const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/school_survey_e2e_0111`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const apiOrigin = `http://127.0.0.1:${proxyPort}`;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const apexOrigin = `http://127.0.0.1:${apexPort}`;
const betterAuthSecret = randomBytes(32).toString("base64url");
const commandTimeoutMs = 600_000;

const ids = {
  department: "department-school-survey-0111",
  foreignDepartment: "department-school-survey-foreign-0111",
  semester: "semester-school-survey-0111",
  survey: "survey.0111.data",
  teamSurvey: "survey-team-counterexample-0111",
  text: "question-school-survey-text-0111",
  list: "__proto__",
  radio: "question-school-survey-radio-0111",
  check: "question-school-survey-check-0111",
  optional: "question-school-survey-optional-0111",
  teamQuestion: "question-team-survey-text-0111",
  volunteer: "person-school-survey-volunteer-0111",
  eligible: 811101,
  eligibleSecond: 811102,
  inactive: 811103,
  foreign: 811104,
  noPlacement: 811105,
  stale: 811106,
};
const surveyDocumentPath = schoolSurveyPath(ids.survey);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const withTimeout = (promise, milliseconds, label) =>
  Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new Error(`${label} timed out after ${milliseconds}ms`);
    }),
  ]);

const run = (command, args, { cwd = repositoryRoot, env = process.env, label }) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: commandTimeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${String(result.status)}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const start = (command, args, { cwd, env, label }) => {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const output = [];
  const capture = (chunk) => {
    output.push(String(chunk));
    if (output.length > 400) output.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return { child, label, output };
};

const stop = async (handle) => {
  if (handle === undefined || handle.child.exitCode !== null) return;
  try {
    process.kill(-handle.child.pid, "SIGTERM");
  } catch (cause) {
    if (cause?.code !== "ESRCH") throw cause;
  }
  await Promise.race([
    new Promise((resolve) => handle.child.once("exit", resolve)),
    delay(5_000).then(() => {
      try {
        process.kill(-handle.child.pid, "SIGKILL");
      } catch (cause) {
        if (cause?.code !== "ESRCH") throw cause;
      }
    }),
  ]);
};

const assertPortAvailable = (port) =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", () => reject(new Error(`required loopback port ${port} is in use`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });

const waitForPort = (port, label) =>
  withTimeout(
    (async () => {
      while (true) {
        const ready = await new Promise((resolve) => {
          const socket = createConnection({ host: "127.0.0.1", port });
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
        });
        if (ready) return;
        await delay(100);
      }
    })(),
    60_000,
    label,
  );

const waitForHttp = (url, label, init) =>
  withTimeout(
    (async () => {
      while (true) {
        try {
          const response = await fetch(url, init);
          if (response.ok) return;
        } catch {
          // The owned process is still starting.
        }
        await delay(150);
      }
    })(),
    60_000,
    label,
  );

const readRequestBody = async (request) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2_000_000) throw new Error("recorded request exceeded 2 MB");
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
};

const startRecordingProxy = async (ledger, control) => {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", apiOrigin);
    const body = await readRequestBody(request);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || ["connection", "content-length", "host"].includes(name)) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else {
        headers.set(name, value);
      }
    }
    let requestJson = null;
    if (body !== undefined && headers.get("content-type")?.includes("json")) {
      requestJson = JSON.parse(body.toString("utf8"));
    }
    const entry = {
      sequence: ledger.length + 1,
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.search,
      idempotencyKey: headers.get("idempotency-key"),
      cookie: headers.get("cookie"),
      authorization: headers.get("authorization"),
      objectCapability: headers.get("x-recruitment-invitation-capability"),
      requestJson,
      status: 0,
      responseHeaders: {},
      responseJson: null,
    };
    ledger.push(entry);
    try {
      const failSurveyRead =
        control.failNextSurveyRead &&
        request.method === "GET" &&
        url.pathname.startsWith("/api/surveys/");
      if (failSurveyRead) control.failNextSurveyRead = false;
      const upstream = failSurveyRead
        ? new Response(
            JSON.stringify({
              type: "urn:vektorprogrammet:problem:v0.2:dependency.unavailable",
              title: "Dependency unavailable",
              status: 503,
              detail: "A required dependency is temporarily unavailable.",
              code: "dependency.unavailable",
            }),
            {
              status: 503,
              headers: {
                "cache-control": "no-store",
                "content-type": "application/problem+json",
                vary: "Origin",
              },
            },
          )
        : await fetch(new URL(request.url ?? "/", backendOrigin), {
            method: request.method,
            headers,
            body,
            redirect: "manual",
          });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      entry.status = upstream.status;
      entry.responseHeaders = Object.fromEntries(upstream.headers.entries());
      if (bytes.length > 0 && upstream.headers.get("content-type")?.includes("json")) {
        entry.responseJson = JSON.parse(bytes.toString("utf8"));
      }
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (
          [
            "connection",
            "content-encoding",
            "content-length",
            "set-cookie",
            "transfer-encoding",
          ].includes(name)
        ) {
          continue;
        }
        response.setHeader(name, value);
      }
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length > 0) response.setHeader("set-cookie", cookies);
      response.end(bytes);
    } catch (cause) {
      response.writeHead(502, { "content-type": "application/problem+json" });
      response.end(JSON.stringify({ error: String(cause) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPort, "127.0.0.1", resolve);
  });
  return server;
};

const closeServer = (server) =>
  server === undefined
    ? Promise.resolve()
    : new Promise((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      );
const relayWorkerResponse = async (upstream, response) => {
  const bytes = Buffer.from(await upstream.arrayBuffer());
  response.statusCode = upstream.status;
  for (const [name, value] of upstream.headers) {
    if (
      [
        "connection",
        "content-encoding",
        "content-length",
        "set-cookie",
        "transfer-encoding",
      ].includes(name)
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  response.end(bytes);
};

const forwardApexDashboardRequest = (request) => {
  const source = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
  return fetch(new URL(`${source.pathname}${source.search}`, dashboardOrigin), {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    ...(body === undefined ? {} : { duplex: "half" }),
  });
};

const startApexDispatcher = async (ledger) => {
  const dashboard = {
    fetch: async (request) => {
      const url = new URL(request.url);
      let assetMiss = false;
      let applicationPath = null;
      const forwarded = await handleDashboardWorkerRequest(
        request,
        {
          PREVIEW_HOST: APEX_IDENTITY.hostname,
          PREVIEW_STAGE: APEX_IDENTITY.stage,
          ASSETS: {
            fetch: async (assetRequest) => {
              const pathname = new URL(assetRequest.url).pathname;
              if (
                pathname.startsWith("/assets/") ||
                pathname.startsWith("/images/") ||
                ["/logo-dark.png", "/logo-light.png", "/vektor-logo-circle.svg"].includes(pathname)
              ) {
                return forwardApexDashboardRequest(assetRequest);
              }
              assetMiss = true;
              return new Response(null, { status: 404 });
            },
          },
        },
        async (applicationRequest) => {
          applicationPath = new URL(applicationRequest.url).pathname;
          return forwardApexDashboardRequest(applicationRequest);
        },
      );
      ledger.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        requestOrigin: url.origin,
        origin: request.headers.get("origin"),
        contentType: request.headers.get("content-type"),
        status: forwarded.status,
        assetFallback: assetMiss && applicationPath !== null,
        applicationPath,
        previewStage: forwarded.headers.get("x-mono-web-stage"),
        previewHost: forwarded.headers.get("x-mono-web-host"),
      });
      return forwarded;
    },
  };
  const server = createServer(async (request, response) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name === "connection" || name === "host") continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, value);
        }
      }
      headers.set("host", APEX_IDENTITY.hostname);
      const body = await readRequestBody(request);
      const source = new URL(request.url ?? "/", `https://${APEX_IDENTITY.hostname}`);
      const upstream = await apexWorker.fetch(
        new Request(source, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
        }),
        {
          Dashboard: dashboard,
          Homepage: {
            fetch: async () =>
              new Response("unexpected homepage dispatch", {
                status: 503,
                headers: { "cache-control": "no-store" },
              }),
          },
          PasswordResetEmail: {
            send: async () => ({ messageId: "unused-school-survey-apex-runner" }),
          },
          PREVIEW_STAGE: APEX_IDENTITY.stage,
          PREVIEW_HOST: APEX_IDENTITY.hostname,
        },
      );
      await relayWorkerResponse(upstream, response);
    } catch (cause) {
      response.writeHead(502, { "content-type": "application/problem+json" });
      response.end(JSON.stringify({ error: String(cause) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(apexPort, "127.0.0.1", resolve);
  });
  return server;
};

const connect = async () => {
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  return client;
};

const query = async (text, values = []) => {
  const client = await connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
};

const api = async (method, path, options = {}) => {
  const {
    body,
    rawBody,
    key,
    contentType = body === undefined && rawBody === undefined ? undefined : "application/json",
  } = options;
  const response = await fetch(`${apiOrigin}${path}`, {
    method,
    headers: {
      ...(contentType === undefined ? {} : { "content-type": contentType }),
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    redirect: "manual",
    ...(body === undefined && rawBody === undefined
      ? {}
      : { body: rawBody ?? JSON.stringify(body) }),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body:
      bytes.length === 0 || !response.headers.get("content-type")?.includes("json")
        ? null
        : JSON.parse(bytes.toString("utf8")),
  };
};
const replayableHeaders = (headers) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !["connection", "content-length", "date", "keep-alive", "transfer-encoding"].includes(name),
    ),
  );

const submitPath = `/api/surveys/${ids.survey}/responses`;
const assertProblem = (result, status, code) => {
  assert.equal(result.status, status);
  assert.equal(result.body?.code, code);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers.vary, "Origin");
  if (code === "validation.failed") {
    assert.equal(result.body?.validation?.truncated, false);
    assert.equal(Array.isArray(result.body?.validation?.errors), true);
    assert.equal(result.body.validation.errors.length > 0, true);
  }
};

const validBody = (schoolId, optionalValue = "Valgfritt svar") => ({
  schoolId,
  answers: [
    { kind: "Check", questionId: ids.check, values: ["Andre", "Første"] },
    { kind: "Text", questionId: ids.text, value: "Et anonymt tekstsvar" },
    { kind: "Radio", questionId: ids.radio, value: "Første" },
    { kind: "Text", questionId: ids.optional, value: optionalValue },
    { kind: "List", questionId: ids.list, value: "Ja" },
  ],
});

const counts = async () => {
  const result = await query(`
    SELECT
      (SELECT count(*)::int FROM public.school_survey_responses) AS responses,
      (SELECT count(*)::int FROM public.school_survey_answers) AS answers,
      (SELECT count(*)::int FROM public.native_http_idempotency_receipts
       WHERE operation_id = 'surveys.submitSchoolSurveyResponse') AS receipts
  `);
  return result.rows[0];
};

const responseAnswers = async (responseId) => {
  const result = await query(
    `SELECT answer.question_id AS "questionId", answer.answer_value AS "answerValue", answer.answer_values AS "answerValues"
       FROM public.school_survey_answers AS answer
       JOIN public.school_survey_questions AS question ON question.question_id = answer.question_id
      WHERE answer.response_id = $1
      ORDER BY question.position ASC`,
    [responseId],
  );
  return result.rows;
};

const seedSql = `
BEGIN;
INSERT INTO public.organization_departments
  (department_id, name, short_name, email, address, city, latitude, longitude, slack_channel, logo_path, active, revision)
VALUES
  ('${ids.department}', 'Undersøkelsesavdeling', 'UND', 'survey.0111@example.invalid', NULL, 'Oslo', NULL, NULL, NULL, NULL, TRUE, 0),
  ('${ids.foreignDepartment}', 'Fremmed avdeling', 'FRE', 'foreign.0111@example.invalid', NULL, 'Bergen', NULL, NULL, NULL, NULL, TRUE, 0);
INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at)
VALUES ('${ids.semester}', '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.000Z');
INSERT INTO public.person_profiles (person_id, first_name, last_name, revision)
VALUES ('${ids.volunteer}', 'Anonym', 'Plassering', 0);
INSERT INTO public.organization_volunteer_affiliations (person_id, department_id, status, revision)
VALUES
  ('${ids.volunteer}', '${ids.department}', 'Active', 1),
  ('${ids.volunteer}', '${ids.foreignDepartment}', 'Active', 1);
INSERT INTO public.schools_directory_schools
  (school_id, name, contact_person, email, phone, language, active, revision)
OVERRIDING SYSTEM VALUE
VALUES
  (${ids.eligible}, 'Alfa skole', 'Kontakt', 'alfa.0111@example.invalid', '+47 90000001', 'Norwegian', TRUE, 0),
  (${ids.eligibleSecond}, 'Zeta skole', 'Kontakt', 'zeta.0111@example.invalid', '+47 90000002', 'Norwegian', TRUE, 0),
  (${ids.inactive}, 'Inaktiv skole', 'Kontakt', 'inactive.0111@example.invalid', '+47 90000003', 'Norwegian', FALSE, 0),
  (${ids.foreign}, 'Fremmed skole', 'Kontakt', 'foreign-school.0111@example.invalid', '+47 90000004', 'Norwegian', TRUE, 0),
  (${ids.noPlacement}, 'Uten plassering', 'Kontakt', 'unplaced.0111@example.invalid', '+47 90000005', 'Norwegian', TRUE, 0),
  (${ids.stale}, 'Blir inaktiv', 'Kontakt', 'stale.0111@example.invalid', '+47 90000006', 'Norwegian', TRUE, 0);
INSERT INTO public.schools_directory_departments (school_id, department_id, revision)
VALUES
  (${ids.eligible}, '${ids.department}', 0),
  (${ids.eligibleSecond}, '${ids.department}', 0),
  (${ids.inactive}, '${ids.department}', 0),
  (${ids.foreign}, '${ids.foreignDepartment}', 0),
  (${ids.noPlacement}, '${ids.department}', 0),
  (${ids.stale}, '${ids.department}', 0);
INSERT INTO public.assistant_placements
  (placement_id, person_id, department_id, semester_id, school_id, day, workdays, block, active, revision)
VALUES
  ('placement-${"a".repeat(64)}', '${ids.volunteer}', '${ids.department}', '${ids.semester}', ${ids.eligible}, 'Monday', 1, '1', TRUE, 1),
  ('placement-${"b".repeat(64)}', '${ids.volunteer}', '${ids.department}', '${ids.semester}', ${ids.eligibleSecond}, 'Tuesday', 1, '1', TRUE, 1),
  ('placement-${"c".repeat(64)}', '${ids.volunteer}', '${ids.department}', '${ids.semester}', ${ids.inactive}, 'Wednesday', 1, '1', TRUE, 1),
  ('placement-${"d".repeat(64)}', '${ids.volunteer}', '${ids.foreignDepartment}', '${ids.semester}', ${ids.foreign}, 'Thursday', 1, '1', TRUE, 1),
  ('placement-${"e".repeat(64)}', '${ids.volunteer}', '${ids.department}', '${ids.semester}', ${ids.stale}, 'Friday', 1, '1', TRUE, 1);
INSERT INTO public.native_survey_definitions
  (survey_id, department_id, semester_id, semester_label, title, completion_text, target_audience)
VALUES
  (
    '${ids.survey}',
    '${ids.department}',
    '${ids.semester}',
    'Høst 2026',
    'Tilbakemelding for skoler',
    'Takk. Svaret ditt er registrert.',
    'School'
  ),
  (
    '${ids.teamSurvey}',
    '${ids.department}',
    '${ids.semester}',
    'Høst 2026',
    'Ikke en skolesurvey',
    'Ikke synlig.',
    'Team'
  );
INSERT INTO public.school_survey_questions
  (question_id, survey_id, question_type, label, help_text, required, position)
VALUES
  ('${ids.text}', '${ids.survey}', 'Text', 'Tekstsvar', 'Skriv et kort svar.', TRUE, 0),
  ('${ids.list}', '${ids.survey}', 'List', 'Velg fra liste', NULL, TRUE, 1),
  ('${ids.radio}', '${ids.survey}', 'Radio', 'Velg ett alternativ', NULL, TRUE, 2),
  ('${ids.check}', '${ids.survey}', 'Check', 'Velg flere alternativer', 'Du kan velge mer enn ett.', TRUE, 3),
  ('${ids.optional}', '${ids.survey}', 'Text', 'Valgfri kommentar', NULL, FALSE, 4),
  ('${ids.teamQuestion}', '${ids.teamSurvey}', 'Text', 'Ikke på denne undersøkelsen', NULL, TRUE, 0);
INSERT INTO public.school_survey_question_alternatives
  (alternative_id, question_id, value, position)
VALUES
  ('alternative-list-ja-0111', '${ids.list}', 'Ja', 0),
  ('alternative-list-nei-0111', '${ids.list}', 'Nei', 1),
  ('alternative-radio-forste-0111', '${ids.radio}', 'Første', 0),
  ('alternative-radio-andre-0111', '${ids.radio}', 'Andre', 1),
  ('alternative-check-forste-0111', '${ids.check}', 'Første', 0),
  ('alternative-check-andre-0111', '${ids.check}', 'Andre', 1),
  ('alternative-check-tredje-0111', '${ids.check}', 'Tredje', 2);
COMMIT;
`;

const checksum = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const exerciseJourney = async (browser, ledger, apexLedger, proxyControl) => {
  const initialForm = await api("GET", `/api/surveys/${ids.survey}`);
  assert.equal(initialForm.status, 200);
  assert.equal(initialForm.headers["cache-control"], "no-store");
  for (const opaqueId of [".", "..", "survey.data", "survey/%/æ"]) {
    const path = schoolSurveyPath(opaqueId);
    const segment = path.slice("/undersokelse/".length);
    assert.equal(schoolSurveyIdFromPathSegment(segment), opaqueId);
    assert.notEqual(segment, ".");
    assert.notEqual(segment, "..");
    assert.equal(segment.endsWith(".data"), false);
  }
  assert.equal(initialForm.headers.vary, "Origin");
  assert.deepEqual(
    initialForm.body.schools.map((school) => school.schoolId),
    [ids.eligible, ids.stale, ids.eligibleSecond],
  );
  assert.deepEqual(
    initialForm.body.questions.map((question) => question.questionId),
    [ids.text, ids.list, ids.radio, ids.check, ids.optional],
  );
  assert.deepEqual(initialForm.body.questions[3].alternatives, ["Første", "Andre", "Tredje"]);

  const pageErrors = [];
  const browserApiOrigins = [];
  const browserApiPaths = [];
  const desktopContext = await browser.newContext({
    baseURL: apexOrigin,
    viewport: { width: 1280, height: 900 },
  });
  const desktopPage = await desktopContext.newPage();
  desktopPage.on("pageerror", (error) => pageErrors.push(error.message));
  desktopPage.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) browserApiPaths.push(url.pathname);
    if (url.origin === apiOrigin || url.origin === backendOrigin) {
      browserApiOrigins.push(url.origin);
    }
  });
  await desktopPage.goto(`/undersokelse/${ids.survey}`);
  await desktopPage.getByRole("heading", { name: "Tilbakemelding for skoler" }).waitFor();
  assert.deepEqual(
    await desktopPage
      .locator("fieldset legend")
      .evaluateAll((legends) => legends.map((legend) => legend.textContent?.trim())),
    [
      "Tekstsvar * (påkrevd)",
      "Velg fra liste * (påkrevd)",
      "Velg ett alternativ * (påkrevd)",
      "Velg flere alternativer * (påkrevd)",
      "Valgfri kommentar (valgfritt)",
    ],
  );
  assert.equal(await desktopPage.getByRole("option", { name: "Alfa skole" }).count(), 1);
  assert.equal(await desktopPage.locator("textarea").count(), 2);
  assert.equal(await desktopPage.locator('select[name^="question:"]').count(), 1);
  assert.equal(await desktopPage.getByRole("radio").count(), 2);
  assert.equal(await desktopPage.getByRole("checkbox").count(), 3);
  const desktopAxe = await new AxeBuilder({ page: desktopPage }).analyze();
  assert.deepEqual(desktopAxe.violations, []);
  assert.equal(
    await desktopPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );

  const initialCommandId = await desktopPage.locator('input[name="commandId"]').inputValue();
  await desktopPage.getByLabel("Skole").selectOption(String(ids.eligible));
  await desktopPage.getByLabel("Tekstsvar").fill("Et anonymt tekstsvar");
  await desktopPage.getByLabel("Valgfri kommentar").fill("Valgfritt svar");
  await desktopPage.getByLabel("Velg fra liste").selectOption("Ja");
  await desktopPage.getByRole("radio", { name: "Første" }).check();
  await desktopPage.getByRole("checkbox", { name: "Første" }).check();
  await desktopPage.getByRole("checkbox", { name: "Andre" }).check();
  proxyControl.failNextSurveyRead = true;
  const unavailableResponsePromise = desktopPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith(surveyDocumentPath),
  );
  await desktopPage.getByRole("button", { name: "Send inn" }).click();
  assert.equal((await unavailableResponsePromise).status(), 200);
  await desktopPage.getByRole("heading", { name: "Skjemaet har feil" }).waitFor();
  assert.equal(
    await desktopPage.getByText("Skjemaet kunne ikke sendes nå. Prøv igjen senere.").count(),
    1,
  );
  assert.equal(
    ledger.some(
      (entry) =>
        entry.method === "GET" &&
        entry.path === `/api/surveys/${ids.survey}` &&
        entry.status === 503,
    ),
    true,
  );
  await desktopPage.waitForFunction(
    () => document.activeElement?.getAttribute("aria-labelledby") === "survey-error-summary",
  );
  assert.equal(await desktopPage.locator('input[name="commandId"]').inputValue(), initialCommandId);
  assert.equal(await desktopPage.getByLabel("Skole").inputValue(), String(ids.eligible));
  assert.equal(await desktopPage.getByLabel("Tekstsvar").inputValue(), "Et anonymt tekstsvar");
  assert.equal(await desktopPage.getByLabel("Valgfri kommentar").inputValue(), "Valgfritt svar");
  assert.equal(await desktopPage.getByLabel("Velg fra liste").inputValue(), "Ja");
  assert.equal(await desktopPage.getByRole("checkbox", { name: "Første" }).isChecked(), true);
  assert.equal(await desktopPage.getByRole("checkbox", { name: "Andre" }).isChecked(), true);
  assert.deepEqual(await counts(), { responses: 0, answers: 0, receipts: 0 });
  await desktopPage.getByLabel("Velg fra liste").selectOption("");
  const rejectedResponsePromise = desktopPage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith(surveyDocumentPath),
  );
  await desktopPage.getByRole("button", { name: "Send inn" }).click();
  const rejectedResponse = await rejectedResponsePromise;
  assert.equal(
    rejectedResponse.status(),
    200,
    JSON.stringify({
      body: await rejectedResponse.text(),
      requestHeaders: await rejectedResponse.request().allHeaders(),
    }),
  );
  await desktopPage.getByRole("heading", { name: "Skjemaet har feil" }).waitFor();
  await desktopPage.waitForFunction(
    () => document.activeElement?.getAttribute("aria-labelledby") === "survey-error-summary",
  );
  assert.equal(await desktopPage.locator('input[name="commandId"]').inputValue(), initialCommandId);
  assert.equal(await desktopPage.getByLabel("Skole").inputValue(), String(ids.eligible));
  assert.equal(await desktopPage.getByLabel("Tekstsvar").inputValue(), "Et anonymt tekstsvar");
  assert.equal(await desktopPage.getByLabel("Valgfri kommentar").inputValue(), "Valgfritt svar");
  assert.equal(await desktopPage.getByRole("checkbox", { name: "Første" }).isChecked(), true);
  assert.equal(await desktopPage.getByRole("checkbox", { name: "Andre" }).isChecked(), true);
  await desktopPage.getByLabel("Velg fra liste").selectOption("Ja");
  await desktopPage.getByRole("button", { name: "Send inn" }).focus();
  await desktopPage.keyboard.press("Enter");
  await desktopPage.getByRole("heading", { name: "Takk for svaret" }).waitFor();
  await desktopPage.waitForFunction(
    () => document.activeElement?.textContent?.trim() === "Takk for svaret",
  );
  assert.equal(await desktopPage.getByText("Takk. Svaret ditt er registrert.").count(), 1);
  assert.equal((await desktopPage.locator("body").innerText()).includes("survey_response_"), false);

  const mobileContext = await browser.newContext({
    baseURL: apexOrigin,
    viewport: { width: 390, height: 844 },
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(`/undersokelse/${ids.survey}`);
  await mobilePage.getByRole("heading", { name: "Tilbakemelding for skoler" }).waitFor();
  assert.equal(
    await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await mobileContext.close();
  await desktopContext.close();
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(browserApiOrigins, []);
  assert.deepEqual(browserApiPaths, []);
  assert.equal(
    apexLedger.some(
      (entry) =>
        entry.method === "GET" &&
        entry.path === `/undersokelse/${ids.survey}` &&
        entry.status === 307 &&
        entry.previewStage === APEX_IDENTITY.stage &&
        entry.previewHost === APEX_IDENTITY.hostname,
    ),
    true,
  );
  assert.equal(
    apexLedger.some(
      (entry) =>
        entry.method === "GET" &&
        entry.path === surveyDocumentPath &&
        entry.assetFallback === true &&
        entry.applicationPath === surveyDocumentPath &&
        entry.status === 200 &&
        entry.previewStage === APEX_IDENTITY.stage &&
        entry.previewHost === APEX_IDENTITY.hostname,
    ),
    true,
  );
  assert.equal(
    apexLedger.some((entry) => entry.method === "POST" && entry.path === surveyDocumentPath),
    true,
  );
  assert.equal(
    apexLedger.some(
      (entry) =>
        entry.method === "GET" && entry.path.startsWith("/assets/") && entry.status === 200,
    ),
    true,
  );
  assert.equal(
    apexLedger.some(
      (entry) => entry.method === "GET" && entry.path === "/__manifest" && entry.status === 200,
    ),
    true,
  );

  const browserSubmission = ledger
    .filter((entry) => entry.method === "POST" && entry.path === submitPath && entry.status === 201)
    .at(-1);
  assert.notEqual(
    browserSubmission,
    undefined,
    "the browser server bridge must submit through the API",
  );
  assert.notEqual(browserSubmission.idempotencyKey, null);
  assert.equal(browserSubmission.cookie, null);
  assert.equal(browserSubmission.authorization, null);
  assert.equal(browserSubmission.objectCapability, null);

  const afterBrowser = await counts();
  assert.deepEqual(afterBrowser, { responses: 1, answers: 5, receipts: 1 });
  const browserResponseId = browserSubmission.responseJson.responseId;
  assert.equal(browserSubmission.responseHeaders["cache-control"], "no-store");
  assert.equal(browserSubmission.responseHeaders["content-type"], "application/json");
  assert.equal(browserSubmission.responseHeaders.vary, "Origin");
  assert.equal(
    browserSubmission.responseHeaders.location,
    `${submitPath}/${encodeURIComponent(browserResponseId)}`,
  );
  assert.match(browserSubmission.responseHeaders.etag, /^"vkr2\.[A-Za-z0-9_-]{43}"$/u);
  assert.deepEqual(await responseAnswers(browserResponseId), [
    { questionId: ids.text, answerValue: "Et anonymt tekstsvar", answerValues: null },
    { questionId: ids.list, answerValue: "Ja", answerValues: null },
    { questionId: ids.radio, answerValue: "Første", answerValues: null },
    { questionId: ids.check, answerValue: null, answerValues: ["Første", "Andre"] },
    { questionId: ids.optional, answerValue: "Valgfritt svar", answerValues: null },
  ]);

  const replay = await api("POST", submitPath, {
    body: browserSubmission.requestJson,
    key: browserSubmission.idempotencyKey,
  });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, browserSubmission.responseJson);
  assert.deepEqual(
    replayableHeaders(replay.headers),
    replayableHeaders(browserSubmission.responseHeaders),
  );
  assert.deepEqual(await counts(), afterBrowser);

  const reorderedReplay = structuredClone(browserSubmission.requestJson);
  reorderedReplay.answers.reverse();
  for (const answer of reorderedReplay.answers) {
    if (answer.kind === "Check") answer.values.reverse();
  }
  const reordered = await api("POST", submitPath, {
    body: reorderedReplay,
    key: browserSubmission.idempotencyKey,
  });
  assert.equal(reordered.status, 201);
  assert.deepEqual(reordered.body, browserSubmission.responseJson);
  assert.deepEqual(
    replayableHeaders(reordered.headers),
    replayableHeaders(browserSubmission.responseHeaders),
  );
  assert.deepEqual(await counts(), afterBrowser);

  const receipt = await query(
    `SELECT identity_sha256 AS "identitySha256"
       FROM public.native_http_idempotency_receipts
      WHERE operation_id = 'surveys.submitSchoolSurveyResponse'
      ORDER BY committed_at DESC
      LIMIT 1`,
  );
  const receiptIdentity = receipt.rows[0]?.identitySha256;
  assert.equal(typeof receiptIdentity, "string");
  const receiptLock = await connect();
  try {
    await receiptLock.query("BEGIN");
    await receiptLock.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
      receiptIdentity,
    ]);
    assertProblem(
      await api("POST", submitPath, {
        body: browserSubmission.requestJson,
        key: browserSubmission.idempotencyKey,
      }),
      409,
      "idempotency.in-flight",
    );
  } finally {
    try {
      await receiptLock.query("ROLLBACK");
    } finally {
      await receiptLock.end();
    }
  }
  assert.deepEqual(await counts(), afterBrowser);

  await query(
    `UPDATE public.native_http_idempotency_receipts
        SET committed_at = transaction_timestamp() - interval '25 hours',
            full_expires_at = transaction_timestamp() - interval '1 hour'
      WHERE identity_sha256 = $1`,
    [receiptIdentity],
  );
  assertProblem(
    await api("POST", submitPath, {
      body: browserSubmission.requestJson,
      key: browserSubmission.idempotencyKey,
    }),
    409,
    "idempotency.response-expired",
  );
  assert.deepEqual(await counts(), afterBrowser);
  const changedReplay = structuredClone(browserSubmission.requestJson);
  const changedText = changedReplay.answers.find(
    (answer) => answer.kind === "Text" && answer.questionId === ids.text,
  );
  assert.notEqual(changedText, undefined);
  changedText.value = "Et endret anonymt tekstsvar";
  assertProblem(
    await api("POST", submitPath, { body: changedReplay, key: browserSubmission.idempotencyKey }),
    409,
    "idempotency.digest-conflict",
  );
  assert.deepEqual(await counts(), afterBrowser);

  const concurrentKey = "school-survey-concurrent-command-0111";
  const concurrentBody = validBody(ids.eligibleSecond, "");
  const concurrent = await Promise.all([
    api("POST", submitPath, { body: concurrentBody, key: concurrentKey }),
    api("POST", submitPath, { body: concurrentBody, key: concurrentKey }),
  ]);
  assert.equal(
    concurrent.some((result) => result.status === 201),
    true,
  );
  assert.equal(
    concurrent.every(
      (result) => result.status === 201 || result.body?.code === "idempotency.in-flight",
    ),
    true,
  );
  const afterConcurrent = await counts();
  assert.deepEqual(afterConcurrent, { responses: 2, answers: 9, receipts: 2 });

  const noWriteCases = [
    {
      name: "missing required answer",
      body: { schoolId: ids.eligible, answers: validBody(ids.eligible).answers.slice(1) },
    },
    {
      name: "unknown question",
      body: {
        ...validBody(ids.eligible),
        answers: [
          ...validBody(ids.eligible).answers,
          { kind: "Text", questionId: "unknown-question-0111", value: "x" },
        ],
      },
    },
    {
      name: "duplicate question",
      body: {
        ...validBody(ids.eligible),
        answers: [
          ...validBody(ids.eligible).answers,
          { kind: "Text", questionId: ids.text, value: "duplikat" },
        ],
      },
    },
    {
      name: "cross-survey question",
      body: {
        ...validBody(ids.eligible),
        answers: [
          ...validBody(ids.eligible).answers,
          { kind: "Text", questionId: ids.teamQuestion, value: "x" },
        ],
      },
    },
    {
      name: "wrong question kind",
      body: {
        ...validBody(ids.eligible),
        answers: validBody(ids.eligible).answers.map((answer) =>
          answer.questionId === ids.text
            ? { kind: "Radio", questionId: ids.text, value: "Første" }
            : answer,
        ),
      },
    },
    {
      name: "duplicate omitted optional answer",
      body: {
        ...validBody(ids.eligible),
        answers: [
          ...validBody(ids.eligible).answers.filter((answer) => answer.questionId !== ids.optional),
          { kind: "Text", questionId: ids.optional, value: " " },
          { kind: "Text", questionId: ids.optional, value: "" },
        ],
      },
    },
    {
      name: "malformed answer",
      body: {
        ...validBody(ids.eligible),
        answers: validBody(ids.eligible).answers.map((answer) =>
          answer.questionId === ids.text ? { ...answer, value: 1 } : answer,
        ),
      },
    },
    {
      name: "invalid alternative",
      body: {
        ...validBody(ids.eligible),
        answers: validBody(ids.eligible).answers.map((answer) =>
          answer.questionId === ids.radio ? { ...answer, value: "Ukjent" } : answer,
        ),
      },
    },
    {
      name: "duplicate checkbox alternative",
      body: {
        ...validBody(ids.eligible),
        answers: validBody(ids.eligible).answers.map((answer) =>
          answer.questionId === ids.check ? { ...answer, values: ["Første", "Første"] } : answer,
        ),
      },
    },
    {
      name: "unknown request property",
      body: { ...validBody(ids.eligible), unexpected: true },
    },
  ];
  for (const [index, testCase] of noWriteCases.entries()) {
    const before = await counts();
    assertProblem(
      await api("POST", submitPath, {
        body: testCase.body,
        key: `school-survey-no-write-${String(index).padStart(2, "0")}-0111`,
      }),
      422,
      "validation.failed",
    );
    assert.deepEqual(await counts(), before, `${testCase.name} must be atomic`);
  }

  for (const [index, schoolId] of [ids.inactive, ids.foreign, ids.noPlacement, 899999].entries()) {
    const before = await counts();
    assertProblem(
      await api("POST", submitPath, {
        body: validBody(schoolId),
        key: `school-survey-ineligible-${String(index).padStart(2, "0")}-0111`,
      }),
      422,
      "validation.failed",
    );
    assert.deepEqual(await counts(), before);
  }

  assert.equal(
    initialForm.body.schools.some((school) => school.schoolId === ids.stale),
    true,
  );
  const staleBody = validBody(ids.stale, "");
  const staleKey = "school-survey-stale-eligibility-0111";
  const acceptedBeforeEligibilityLoss = await api("POST", submitPath, {
    body: staleBody,
    key: staleKey,
  });
  assert.equal(acceptedBeforeEligibilityLoss.status, 201);
  const staleReceipt = await query(
    `SELECT identity_sha256 AS "identitySha256"
       FROM public.native_http_idempotency_receipts
      WHERE operation_id = 'surveys.submitSchoolSurveyResponse'
      ORDER BY committed_at DESC
      LIMIT 1`,
  );
  const staleReceiptIdentity = staleReceipt.rows[0]?.identitySha256;
  assert.equal(typeof staleReceiptIdentity, "string");
  const afterStaleCommit = await counts();
  await query("UPDATE public.schools_directory_schools SET active = FALSE WHERE school_id = $1", [
    ids.stale,
  ]);
  assertProblem(
    await api("POST", submitPath, { body: staleBody, key: staleKey }),
    422,
    "validation.failed",
  );
  assert.deepEqual(await counts(), afterStaleCommit);
  const expiredStaleReceipt = await query(
    `UPDATE public.native_http_idempotency_receipts
        SET committed_at = transaction_timestamp() - interval '25 hours',
            full_expires_at = transaction_timestamp() - interval '1 hour'
      WHERE identity_sha256 = $1`,
    [staleReceiptIdentity],
  );
  assert.equal(expiredStaleReceipt.rowCount, 1);
  assertProblem(
    await api("POST", submitPath, { body: staleBody, key: staleKey }),
    422,
    "validation.failed",
  );
  assert.deepEqual(await counts(), afterStaleCommit);
  assertProblem(
    await api("POST", submitPath, {
      body: staleBody,
      key: "school-survey-stale-new-command-0111",
    }),
    422,
    "validation.failed",
  );
  assert.deepEqual(await counts(), afterStaleCommit);

  const trimmedBoundaryValue = "x".repeat(4_096);
  const trimmedBoundaryBody = validBody(ids.eligible, "");
  trimmedBoundaryBody.answers = trimmedBoundaryBody.answers.map((answer) =>
    answer.questionId === ids.text ? { ...answer, value: `\t${trimmedBoundaryValue}\t` } : answer,
  );
  const trimmedBoundaryResponse = await api("POST", submitPath, {
    body: trimmedBoundaryBody,
    key: "school-survey-trimmed-boundary-0111",
  });
  assert.equal(trimmedBoundaryResponse.status, 201);
  const trimmedBoundaryAnswers = await responseAnswers(trimmedBoundaryResponse.body.responseId);
  assert.equal(
    trimmedBoundaryAnswers.find((answer) => answer.questionId === ids.text)?.answerValue,
    trimmedBoundaryValue,
  );

  assertProblem(await api("GET", "/api/surveys/unknown-survey-0111"), 404, "resource.not-found");
  assertProblem(await api("GET", `/api/surveys/${ids.teamSurvey}`), 404, "resource.not-found");
  assertProblem(
    await api("POST", "/api/surveys/unknown-survey-0111/responses", {
      body: validBody(ids.eligible),
      key: "school-survey-unknown-post-0111",
    }),
    404,
    "resource.not-found",
  );
  assertProblem(
    await api("POST", `/api/surveys/${ids.teamSurvey}/responses`, {
      body: validBody(ids.eligible),
      key: "school-survey-non-school-post-0111",
    }),
    404,
    "resource.not-found",
  );
  assertProblem(
    await api("POST", submitPath, { body: validBody(ids.eligible), key: "short" }),
    400,
    "idempotency-key.invalid",
  );
  assertProblem(
    await api("POST", submitPath, {
      body: validBody(ids.eligible),
      key: "school-survey-wrong-content-type-0111",
      contentType: "text/plain",
    }),
    415,
    "media-type.unsupported",
  );
  const bodyAtLimitPrefix = '{"unexpected":"';
  const bodyAtLimitSuffix = '"}';
  const rawBodyAtLimit = `${bodyAtLimitPrefix}${"x".repeat(
    65_536 - Buffer.byteLength(bodyAtLimitPrefix) - Buffer.byteLength(bodyAtLimitSuffix),
  )}${bodyAtLimitSuffix}`;
  assert.equal(Buffer.byteLength(rawBodyAtLimit), 65_536);
  assertProblem(
    await api("POST", submitPath, {
      rawBody: rawBodyAtLimit,
      key: "school-survey-request-limit-0111",
    }),
    422,
    "validation.failed",
  );
  const rawBodyAboveLimit = `${rawBodyAtLimit} `;
  assert.equal(Buffer.byteLength(rawBodyAboveLimit), 65_537);
  assertProblem(
    await api("POST", submitPath, {
      rawBody: rawBodyAboveLimit,
      key: "school-survey-large-request-0111",
    }),
    413,
    "request.too-large",
  );
  const surveyRequests = ledger.filter((entry) => entry.path.startsWith("/api/surveys/"));
  assert.equal(surveyRequests.length > 0, true);
  for (const entry of surveyRequests) {
    assert.equal(entry.cookie, null, `survey request ${entry.sequence} must not carry a cookie`);
    assert.equal(
      entry.authorization,
      null,
      `survey request ${entry.sequence} must not carry bearer authorization`,
    );
    assert.equal(
      entry.objectCapability,
      null,
      `survey request ${entry.sequence} must not carry an object capability`,
    );
  }

  return {
    anonymousOpen: true,
    sourceOrder: true,
    prototypeNamedQuestionId: true,
    fourQuestionTypes: true,
    browserServerGeneratedSdkBridge: true,
    dottedSurveyId: true,
    canonicalDocumentRedirect: true,
    opaqueSurveyIdPathCodec: true,
    dashboardWorkerAssetFallback: true,
    readFailureDraftPreserved: true,
    rejectedDraftPreserved: true,
    committedCompletion: true,
    normalizedPostgresAnswers: true,
    createdResponseHeaders: true,
    exactReplay: true,
    trimmedAnswerBoundary: true,
    reorderedReplay: true,
    digestConflict: true,
    inFlightReceipt: true,
    expiredReceipt: true,
    concurrentSingleResponse: true,
    requestBodyBoundary: { acceptedBytes: 65_536, rejectedBytes: 65_537 },
    atomicValidationFailures: noWriteCases.map(({ name }) => name),
    ineligibleSchools: ["inactive", "foreign department", "no placement", "unknown", "stale"],
    eligibilityReplayPrecedence: true,
    unknownAndNonSchoolNotFound: true,
    apexDispatcher: { document: true, dataAction: true },
    responsive: { desktop: true, mobile390: true },
    keyboardSubmission: true,
    errorFocus: true,
    completionFocus: true,
    accessibilityViolations: desktopAxe.violations.length,
    noCredentialsObserved: true,
  };
};

const initialRevision = run("git", ["rev-parse", "HEAD"], {
  label: "0111 source revision",
}).stdout.trim();
assert.notEqual(initialRevision, "");
assert.equal(
  run("git", ["status", "--short"], { label: "0111 source cleanliness" }).stdout.trim(),
  "",
  "0111 runtime must start from a clean tree",
);

const temporaryRoot = await mkdtemp(join(tmpdir(), "native-school-survey-0111-"));
const postgresData = join(temporaryRoot, "postgres");
const ledger = [];
const apexLedger = [];
const proxyControl = { failNextSurveyRead: false };
let postgres;
let backend;
let dashboard;
let proxy;
let apex;
let browser;
let journey;
let version;
let primaryError;
let cleanupError;

try {
  await Promise.all(
    [postgresPort, backendPort, proxyPort, dashboardPort, apexPort].map(assertPortAvailable),
  );
  run(
    "initdb",
    ["-D", postgresData, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"],
    { label: "0111 PostgreSQL initialization" },
  );
  postgres = start(
    "postgres",
    ["-D", postgresData, "-p", String(postgresPort), "-h", "127.0.0.1", "-k", temporaryRoot],
    { cwd: repositoryRoot, env: process.env, label: "0111 PostgreSQL" },
  );
  await waitForPort(postgresPort, "0111 PostgreSQL startup");
  run(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres", "school_survey_e2e_0111"],
    { label: "0111 database creation" },
  );

  const backendEnvironment = {
    ...process.env,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: betterAuthSecret,
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
    OAUTH_CANONICAL_ORIGIN: backendOrigin,
    OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    ADMISSION_AUTH_TOKENS: "{}",
    RECEIPT_AUTH_TOKENS: "{}",
    ORGANIZATION_AUTH_TOKENS: "{}",
  };
  backend = start("bun", ["run", "src/main.ts"], {
    cwd: backendRoot,
    env: backendEnvironment,
    label: "0111 native backend",
  });
  await waitForHttp(`${backendOrigin}/health`, "0111 native backend startup");
  await query(seedSql);
  version = (await query("SHOW server_version")).rows[0].server_version;
  proxy = await startRecordingProxy(ledger, proxyControl);
  await waitForHttp(`${apiOrigin}/health`, "0111 recording proxy startup");

  const dashboardEnvironment = {
    ...process.env,
    API_URL: apiOrigin,
    VITE_API_URL: apiOrigin,
    DASHBOARD_MOUNT: "/",
    DASHBOARD_ORIGIN: apexOrigin,
    PREVIEW_HOST: APEX_IDENTITY.hostname,
    HOST: "127.0.0.1",
    PORT: String(dashboardPort),
    NODE_ENV: "production",
  };
  run("bun", ["run", "build"], {
    cwd: sdkRoot,
    env: dashboardEnvironment,
    label: "0111 generated SDK build",
  });
  run("bun", ["run", "build"], {
    cwd: dashboardRoot,
    env: dashboardEnvironment,
    label: "0111 dashboard production build",
  });
  dashboard = start(
    process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
    ["node_modules/@react-router/serve/dist/cli.js", "build/server/index.js"],
    { cwd: dashboardRoot, env: dashboardEnvironment, label: "0111 dashboard" },
  );
  await waitForHttp(`${dashboardOrigin}${surveyDocumentPath}`, "0111 dashboard startup");
  apex = await startApexDispatcher(apexLedger);
  await waitForHttp(
    `${apexOrigin}/undersokelse/${ids.survey}`,
    "0111 apex dashboard route startup",
    { headers: { Accept: "text/html" } },
  );
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      "/etc/profiles/per-user/nori/bin/chromium-browser",
  });
  journey = await exerciseJourney(browser, ledger, apexLedger, proxyControl);
} catch (cause) {
  primaryError = cause;
  if (backend !== undefined) process.stderr.write(`Backend tail:\n${backend.output.join("")}\n`);
  process.stderr.write(`Native transport tail:\n${JSON.stringify(ledger.slice(-10), null, 2)}\n`);
  process.stderr.write(`Apex transport tail:\n${JSON.stringify(apexLedger.slice(-10), null, 2)}\n`);
  if (dashboard !== undefined)
    process.stderr.write(`Dashboard tail:\n${dashboard.output.join("")}\n`);
} finally {
  const cleanupFailures = [];
  const cleanup = async (operation) => {
    try {
      await operation();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  };
  await cleanup(async () => {
    if (browser !== undefined) await browser.close();
  });
  await cleanup(() => closeServer(apex));
  await cleanup(() => stop(dashboard));
  await cleanup(() => closeServer(proxy));
  await cleanup(() => stop(backend));
  await cleanup(() => stop(postgres));
  await cleanup(() => rm(temporaryRoot, { recursive: true, force: true }));
  await cleanup(() =>
    Promise.all(
      [postgresPort, backendPort, proxyPort, dashboardPort, apexPort].map(assertPortAvailable),
    ),
  );
  if (cleanupFailures.length > 0) {
    cleanupError =
      cleanupFailures.length === 1
        ? cleanupFailures[0]
        : new AggregateError(cleanupFailures, "0111 cleanup failed");
  }
}

if (primaryError !== undefined && cleanupError !== undefined) {
  throw new AggregateError([primaryError, cleanupError], "0111 journey and cleanup failed");
}
if (primaryError !== undefined) throw primaryError;
if (cleanupError !== undefined) throw cleanupError;

const manifest = {
  specId: "0111",
  result: "passed",
  runtimeRevision: initialRevision,
  command: "bun --cwd apps/dashboard e2e/run-real-native-school-survey.mjs",
  topology: {
    database: version,
    backend: "native Effect HTTP API",
    sdk: "generated @vektorprogrammet/sdk",
    dashboard: "dashboard worker asset dispatcher and production React Router server bridge",
    apex: "local execution of the apex edge dispatcher",
    browser: "real headless Chromium",
  },
  evidence: {
    runtime: {
      gates: journey,
      commands: [
        "bun --cwd packages/sdk run build",
        "bun --cwd apps/dashboard run build",
        "Chromium school-survey journey",
      ],
    },
    typeChecks: { commands: [], result: "not-run-separately" },
    unitTests: { commands: [], result: "not-run" },
  },
  checksums: {
    runner: await checksum(runnerPath),
    designSpec: await checksum(specPath),
  },
  skippedOrUnavailable: [],
  cleanup: {
    postgresRemoved: true,
    temporaryRootRemoved: true,
    portsReleased: [postgresPort, backendPort, proxyPort, dashboardPort, apexPort],
    productionResourcesUsed: false,
  },
};
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await chmod(manifestPath, 0o600);
process.stdout.write(`${JSON.stringify(manifest)}\n`);
