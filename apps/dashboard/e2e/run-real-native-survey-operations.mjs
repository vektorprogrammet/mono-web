import { Predicate } from "effect";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import pg from "pg";
import { schoolSurveyPath } from "../app/lib/school-survey-path.ts";
import {
  createSurveyBody,
  identitySeedPersons,
  ids,
  personas,
  seedSql,
} from "./fixtures/survey-operations.mjs";

const { Client } = pg;

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));

const backendRoot = fileURLToPath(new URL("../../backend/", import.meta.url));

const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));

const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));

const runnerPath = fileURLToPath(import.meta.url);

const contractPath = join(repositoryRoot, "docs/specs/0113-school-survey-operations.md");

const manifestPath =
  process.env.SURVEY_OPERATIONS_EVIDENCE_MANIFEST_PATH ??
  join(repositoryRoot, "artifacts/runtime/survey-operations-0113.json");

const postgresPort = 45430;

const backendPort = 45431;

const proxyPort = 45432;

const dashboardPort = 5174;

const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/survey_operations_e2e_0113`;

const backendOrigin = `http://127.0.0.1:${backendPort}`;

const apiOrigin = `http://127.0.0.1:${proxyPort}`;

const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

const betterAuthSecret = randomBytes(32).toString("base64url");

const commandTimeoutMs = 600_000;

const adminPath = "/api/surveys/admin";

const readinessTimeoutMs = 60_000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  const handle = { child, label, output, startupError: null };

  const capture = (chunk) => {
    output.push(String(chunk));

    if (output.length > 400) output.shift();
  };

  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (cause) => {
    handle.startupError = cause;
    capture(`${label} failed to start: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  });

  return handle;
};

const assertProcessStarting = (handle) => {
  if (handle === undefined) return;

  if (handle.startupError !== null) throw handle.startupError;

  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    throw new Error(
      `${handle.label} exited before readiness (code=${String(handle.child.exitCode)}, signal=${String(handle.child.signalCode)}):\n${handle.output.join("")}`,
    );
  }
};

const stop = async (handle) => {
  if (handle === undefined || handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return;
  }

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

const waitForPort = async (port, label, handle) => {
  const deadline = Date.now() + readinessTimeoutMs;

  while (Date.now() < deadline) {
    assertProcessStarting(handle);

    const ready = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (ready) return;
    await delay(100);
  }

  throw new Error(`${label} timed out after ${readinessTimeoutMs}ms`);
};

const waitForHttp = async (url, label, handle) => {
  const deadline = Date.now() + readinessTimeoutMs;

  while (Date.now() < deadline) {
    assertProcessStarting(handle);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });

      if (response.ok) return;
    } catch {
      // The owned process is still starting.
    }

    await delay(150);
  }

  throw new Error(`${label} timed out after ${readinessTimeoutMs}ms`);
};

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

const startRecordingProxy = async (ledger) => {
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
      try {
        requestJson = JSON.parse(body.toString("utf8"));
      } catch {
        requestJson = "malformed";
      }
    }

    const entry = {
      sequence: ledger.length + 1,
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.search,
      idempotencyKey: headers.get("idempotency-key"),
      cookie: headers.get("cookie"),
      authorization: headers.get("authorization"),
      requestJson,
      status: 0,
      responseHeaders: {},
      responseJson: null,
      responseText: "",
    };

    ledger.push(entry);

    try {
      const upstream = await fetch(new URL(`${url.pathname}${url.search}`, backendOrigin), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });

      const bytes = Buffer.from(await upstream.arrayBuffer());
      entry.status = upstream.status;
      entry.responseHeaders = Object.fromEntries(upstream.headers.entries());
      entry.responseText = bytes.toString("utf8");

      if (upstream.headers.get("content-type")?.includes("json") && bytes.length > 0) {
        try {
          entry.responseJson = JSON.parse(entry.responseText);
        } catch {
          entry.responseJson = "malformed";
        }
      }

      const forwardedHeaders = {};

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

        forwardedHeaders[name] = value;
      }

      const setCookies = upstream.headers.getSetCookie();

      if (setCookies.length > 0) forwardedHeaders["set-cookie"] = setCookies;
      response.writeHead(upstream.status, forwardedHeaders);
      response.end(bytes);
    } catch (cause) {
      entry.status = 502;
      entry.responseJson = { code: "dependency.unavailable" };
      response.writeHead(502, { "content-type": "application/problem+json" });
      response.end(
        JSON.stringify({
          type: "urn:vektorprogrammet:problem:v0.2:dependency.unavailable",
          title: "Dependency unavailable",
          status: 502,
          code: "dependency.unavailable",
          detail: cause instanceof Error ? cause.message : "Proxy could not reach backend.",
        }),
      );
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

const api = async (cookie, method, path, { body, key } = {}) => {
  const headers = new Headers({ origin: dashboardOrigin });

  if (cookie !== undefined) headers.set("cookie", cookie);

  if (body !== undefined) headers.set("content-type", "application/json");

  if (key !== undefined) headers.set("idempotency-key", key);

  const init = { method, headers, redirect: "manual" };

  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(`${apiOrigin}${path}`, init);

  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let decoded = null;

  if (response.headers.get("content-type")?.includes("json") && bytes.length > 0) {
    decoded = JSON.parse(text);
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: decoded,
    text,
  };
};

const assertProblem = (response, status, code) => {
  assert.equal(response.status, status);
  assert.equal(response.body?.status, status);
  assert.equal(response.body?.code, code);
  assert.match(response.headers["content-type"] ?? "", /^application\/problem\+json/u);
};

const assertDenied = (response, label) => {
  assert.ok(
    response.status === 403 || response.status === 404,
    `${label} expected concealed or explicit denial, received ${response.status}`,
  );
};

const counts = async () => {
  const result = await query(`
    SELECT
      (SELECT count(*)::int FROM public.native_survey_definitions WHERE target_audience = 'School') AS surveys,
      (SELECT count(*)::int FROM public.school_survey_responses) AS responses,
      (SELECT count(*)::int FROM public.school_survey_answers) AS answers,
      (SELECT count(*)::int FROM public.school_survey_audit) AS audit,
      (SELECT count(*)::int FROM public.native_http_idempotency_receipts
         WHERE operation_id IN ('surveys.createAdminSurvey', 'surveys.closeAdminSurvey', 'surveys.submitSchoolSurveyResponse')) AS receipts
  `);

  return result.rows[0];
};

const signIn = async (browser, persona) => {
  const context = await browser.newContext({
    baseURL: dashboardOrigin,
    viewport: { width: 1440, height: 960 },
  });

  const page = await context.newPage();
  await page.goto("/login");
  await page.getByRole("heading", { name: "Vektorprogrammet", exact: true }).waitFor();
  await page.getByLabel("E-post").fill(persona.email);
  await page.getByLabel("Passord", { exact: true }).fill(persona.password);
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  await page.waitForURL(
    (url) =>
      url.pathname === "/dashboard" || url.pathname === "/dashboard/" || url.pathname === "/",
    { timeout: 15_000 },
  );

  const cookies = (await context.cookies(dashboardOrigin)).filter(({ name }) =>
    ["better-auth.session_token", "__Secure-better-auth.session_token"].includes(name),
  );

  assert.equal(cookies.length, 1, `one Better Auth cookie for ${persona.email}`);

  return {
    context,
    page,
    cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
  };
};

const streamToText = async (stream) => {
  const chunks = [];

  for await (const chunk of stream) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks).toString("utf8");
};

const closeSurveyPath = (surveyId) => `${adminPath}/${encodeURIComponent(surveyId)}/close`;

const resultsPath = (surveyId) => `${adminPath}/${encodeURIComponent(surveyId)}/results`;

const resultsCsvPath = (surveyId) => `${resultsPath(surveyId)}.csv`;

const publicSurveyPath = (surveyId) => `/api/surveys/public/${encodeURIComponent(surveyId)}`;

const publicResponsePath = (surveyId) => `${publicSurveyPath(surveyId)}/responses`;

const exerciseJourney = async ({ browser, ledger }) => {
  const leader = await signIn(browser, personas.leader);
  const foreignLeader = await signIn(browser, personas.foreignLeader);
  const ordinary = await signIn(browser, personas.ordinary);
  const inactive = await signIn(browser, personas.inactive);
  const administrator = await signIn(browser, personas.administrator);
  const pageErrors = [];
  leader.page.on("pageerror", (error) => pageErrors.push(error.message));

  assertProblem(await api(undefined, "GET", `${adminPath}/catalog`), 401, "credential.invalid");
  assertDenied(
    await api(ordinary.cookie, "GET", `${adminPath}/catalog`),
    "ordinary member catalog",
  );
  assertDenied(
    await api(inactive.cookie, "GET", `${adminPath}/catalog`),
    "inactive leader catalog",
  );
  assertDenied(
    await api(
      foreignLeader.cookie,
      "GET",
      `${adminPath}?departmentId=${ids.department}&semesterId=${ids.semester}`,
    ),
    "wrong-department list",
  );

  const catalog = await api(leader.cookie, "GET", `${adminPath}/catalog`);
  assert.equal(catalog.status, 200);
  assert.deepEqual(
    catalog.body.departments.map(({ departmentId }) => departmentId),
    [ids.department],
  );
  assert.equal(
    catalog.body.semesters.some(({ semesterId }) => semesterId === ids.semester),
    true,
  );

  await leader.page.goto("/dashboard/undersokelser");
  await leader.page.getByRole("heading", { name: "Undersøkelser" }).waitFor();
  await leader.page.getByRole("button", { name: "Assistenter", exact: true }).click();

  const surveyNavigation = leader.page.getByRole("link", {
    name: "Undersøkelser",
    exact: true,
  });

  await surveyNavigation.waitFor();
  assert.equal(
    new URL(await surveyNavigation.getAttribute("href"), dashboardOrigin).pathname,
    "/dashboard/undersokelser",
  );
  await leader.page
    .locator("#school-surveys-department option")
    .filter({ hasText: "Undersøkelsesavdelingen" })
    .waitFor({ state: "attached" });
  await leader.page.locator("#school-surveys-department").focus();
  await leader.page.keyboard.press("Tab");
  assert.equal(
    await leader.page
      .locator("#school-surveys-semester")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await leader.page.selectOption("#school-surveys-department", ids.department);
  await leader.page.selectOption("#school-surveys-semester", ids.semester);
  await leader.page.getByRole("heading", { name: "Ingen undersøkelser" }).waitFor();

  await leader.page.fill("#school-surveys-title", "Skolenes tilbakemelding 0113");
  await leader.page.fill(
    "#school-surveys-completion",
    "Takk for at skolen delte erfaringene sine.",
  );
  await leader.page.getByRole("button", { name: "Legg til tekstspørsmål" }).click();
  await leader.page.getByRole("button", { name: "Legg til listespørsmål" }).click();
  await leader.page.getByRole("button", { name: "Legg til ettvalgs-spørsmål" }).click();
  await leader.page.getByRole("button", { name: "Legg til flervalgsspørsmål" }).click();
  await leader.page.fill("#school-survey-question-1-label", "Hva fungerte best?");
  await leader.page.fill("#school-survey-question-1-help", "Beskriv en konkret erfaring.");
  await leader.page.check("#school-survey-question-1-required");
  await leader.page.uncheck("#school-survey-question-1-required");
  assert.equal(await leader.page.isChecked("#school-survey-question-1-required"), false);
  await leader.page.check("#school-survey-question-1-required");
  await leader.page.fill("#school-survey-question-2-label", "Vil skolen delta igjen?");
  await leader.page.fill("#school-survey-question-2-alternative-0", "Ja");
  await leader.page.fill("#school-survey-question-2-alternative-1", "Nei");
  await leader.page.fill("#school-survey-question-3-label", "Hvordan opplevdes samarbeidet?");
  await leader.page.fill("#school-survey-question-3-alternative-0", "Godt");
  await leader.page.fill("#school-survey-question-3-alternative-1", "Dårlig");
  await leader.page.fill("#school-survey-question-4-label", "Hva ønsker skolen mer av?");
  await leader.page.fill("#school-survey-question-4-alternative-0", "Besøk");
  await leader.page.fill("#school-survey-question-4-alternative-1", "Informasjon");
  await leader.page.getByRole("button", { name: "Legg til alternativ" }).last().click();
  await leader.page.fill("#school-survey-question-4-alternative-2", "Materiell");
  await leader.page.getByRole("button", { name: "Opprett undersøkelse" }).click();
  await leader.page
    .getByText("Undersøkelsen er opprettet. Oversikten oppdateres fra serveren.")
    .waitFor();

  const browserCreate = ledger.find(
    (entry) =>
      entry.method === "POST" &&
      entry.path === adminPath &&
      entry.requestJson?.title === "Skolenes tilbakemelding 0113" &&
      entry.status === 201,
  );

  assert.ok(browserCreate, "dashboard create reached the generated SDK backend path");
  const surveyId = browserCreate.responseJson?.surveyId;
  assert.equal(Predicate.isString(surveyId), true);
  const createdRow = leader.page.locator(`tr[data-survey-id="${surveyId}"]`);
  await createdRow.waitFor();
  assert.equal(
    (await createdRow.locator("td").nth(1).innerText()).trim(),
    "0",
    "created survey lists zero responses",
  );

  const publicContext = await browser.newContext({
    baseURL: dashboardOrigin,
    viewport: { width: 1440, height: 960 },
  });

  const publicPage = await publicContext.newPage();
  await publicPage.goto(schoolSurveyPath(surveyId));
  await publicPage.getByRole("heading", { name: "Skolenes tilbakemelding 0113" }).waitFor();
  await publicPage.selectOption("#survey-school", String(ids.school));
  await publicPage.locator("textarea").fill("Et konkret svar fra skolen");
  await publicPage.locator("select").nth(1).selectOption({ label: "Ja" });
  await publicPage.getByLabel("Godt").check();
  await publicPage.getByLabel("Besøk").check();
  await publicPage.getByLabel("Materiell").check();
  await publicPage.getByRole("button", { name: "Send inn" }).click();
  await publicPage.getByRole("heading", { name: "Takk for svaret" }).waitFor();
  await publicContext.close();

  const afterPublicResponse = await counts();
  assert.equal(afterPublicResponse.audit, 1);
  assert.equal(afterPublicResponse.responses, 1);
  assert.equal(afterPublicResponse.answers, 4);

  await leader.page.goto("/dashboard/undersokelser");
  await leader.page.getByRole("heading", { name: "Undersøkelser" }).waitFor();
  await leader.page.locator(`tr[data-survey-id="${surveyId}"]`).waitFor();
  await leader.page
    .locator(`tr[data-survey-id="${surveyId}"]`)
    .getByRole("button", { name: "Åpne" })
    .click();
  assert.equal(
    await leader.page.getByRole("link", { name: "Åpne offentlig skjema" }).getAttribute("href"),
    schoolSurveyPath(surveyId),
  );
  await leader.page.getByRole("button", { name: "Vis resultater" }).click();
  await leader.page.getByRole("heading", { name: "Anonyme svar" }).waitFor();
  const resultRow = leader.page.locator(".school-surveys__answers-table tbody tr");
  assert.match(await resultRow.innerText(), /Alfa skole/u);
  assert.match(await resultRow.innerText(), /Et konkret svar fra skolen/u);
  assert.match(await resultRow.innerText(), /Ja/u);
  assert.match(await resultRow.innerText(), /Godt/u);
  assert.match(await resultRow.innerText(), /Besøk · Materiell/u);
  const resultProjection = await api(leader.cookie, "GET", resultsPath(surveyId));
  assert.equal(resultProjection.status, 200);
  assert.equal(resultProjection.body.responseCount, 1);
  const projectedResponse = resultProjection.body.responses[0];
  assert.equal(projectedResponse.school.schoolId, ids.school);
  assert.deepEqual(projectedResponse.answers, [
    {
      kind: "Text",
      questionId: browserCreate.responseJson.questions[0].questionId,
      value: "Et konkret svar fra skolen",
    },
    { kind: "List", questionId: browserCreate.responseJson.questions[1].questionId, value: "Ja" },
    {
      kind: "Radio",
      questionId: browserCreate.responseJson.questions[2].questionId,
      value: "Godt",
    },
    {
      kind: "Check",
      questionId: browserCreate.responseJson.questions[3].questionId,
      values: ["Besøk", "Materiell"],
    },
  ]);

  const downloadPromise = leader.page.waitForEvent("download");
  await leader.page.getByRole("link", { name: "Last ned CSV" }).click();
  const download = await downloadPromise;
  const csvStream = await download.createReadStream();
  assert.notEqual(csvStream, null);
  const csv = await streamToText(csvStream);
  assert.equal(
    csv,
    [
      "submittedAt,school,Hva fungerte best?,Vil skolen delta igjen?,Hvordan opplevdes samarbeidet?,Hva ønsker skolen mer av?",
      `${projectedResponse.submittedAt},Alfa skole,Et konkret svar fra skolen,Ja,Godt,Besøk; Materiell`,
      "",
    ].join("\r\n"),
  );

  const csvApi = ledger.find(
    (entry) =>
      entry.method === "GET" && entry.path === resultsCsvPath(surveyId) && entry.status === 200,
  );

  assert.ok(csvApi, "download traversed the server SDK bridge to CSV export");
  assert.match(csvApi.responseHeaders["cache-control"] ?? "", /private, no-store/u);
  assert.equal(
    csvApi.responseHeaders["content-disposition"],
    `attachment; filename="school-survey-${encodeURIComponent(surveyId)}-results.csv"`,
  );
  const createdRevision = browserCreate.responseJson.revision;
  assert.equal(Predicate.isNumber(createdRevision), true);
  await leader.page.getByRole("button", { name: "Lukk undersøkelse" }).click();
  await leader.page
    .getByText("Undersøkelsen er lukket. Oversikten oppdateres fra serveren.")
    .waitFor();
  await leader.page
    .locator(".school-surveys__detail .school-surveys__state")
    .filter({ hasText: /^Lukket$/u })
    .waitFor();

  const beforeClosedPublicWrite = await counts();
  assert.equal(beforeClosedPublicWrite.audit, 2);
  assertProblem(await api(undefined, "GET", publicSurveyPath(surveyId)), 404, "resource.not-found");
  assertProblem(
    await api(undefined, "POST", publicResponsePath(surveyId), {
      key: "survey-operations-closed-public-write-0113",
      body: {
        schoolId: ids.schoolSecond,
        answers: [],
      },
    }),
    404,
    "resource.not-found",
  );
  assert.deepEqual(await counts(), beforeClosedPublicWrite);

  const staleClose = await api(leader.cookie, "POST", closeSurveyPath(surveyId), {
    key: "survey-operations-stale-close-0113",
    body: { expectedRevision: createdRevision },
  });

  assertProblem(staleClose, 412, "precondition.failed");

  const repeatedClose = await api(leader.cookie, "POST", closeSurveyPath(surveyId), {
    key: "survey-operations-repeated-close-0113",
    body: { expectedRevision: createdRevision + 1 },
  });

  assertProblem(repeatedClose, 412, "precondition.failed");
  assert.deepEqual(await counts(), beforeClosedPublicWrite);

  const beforeInvalid = await counts();
  assertProblem(
    await api(leader.cookie, "POST", adminPath, {
      key: "survey-operations-invalid-create-0113",
      body: createSurveyBody({ title: "", questions: [] }),
    }),
    422,
    "validation.failed",
  );
  assert.deepEqual(await counts(), beforeInvalid);

  const unbrokenTitle = "U".repeat(255);

  const confidential = await api(administrator.cookie, "POST", adminPath, {
    key: "survey-operations-confidential-0113",
    body: createSurveyBody({
      title: unbrokenTitle,
      resultsVisibility: "GlobalAdministrators",
    }),
  });

  assert.equal(confidential.status, 201);
  assert.equal(Predicate.isString(confidential.body?.surveyId), true);
  assertDenied(
    await api(leader.cookie, "GET", resultsPath(confidential.body.surveyId)),
    "department leader confidential results",
  );
  assertDenied(
    await api(leader.cookie, "GET", resultsCsvPath(confidential.body.surveyId)),
    "department leader confidential CSV",
  );

  const beforeReplay = await counts();
  const replayBody = createSurveyBody({ title: "Idempotent skoleundersøkelse" });
  const replayKey = "survey-operations-idempotent-create-0113";

  const firstReplay = await api(leader.cookie, "POST", adminPath, {
    key: replayKey,
    body: replayBody,
  });

  const secondReplay = await api(leader.cookie, "POST", adminPath, {
    key: replayKey,
    body: replayBody,
  });

  assert.equal(firstReplay.status, 201);
  assert.equal(secondReplay.status, 201);
  assert.deepEqual(secondReplay.body, firstReplay.body);
  const afterReplay = await counts();
  assert.deepEqual(afterReplay, {
    ...beforeReplay,
    surveys: beforeReplay.surveys + 1,
    audit: beforeReplay.audit + 1,
    receipts: beforeReplay.receipts + 1,
  });

  const beforeConcurrent = await counts();
  const concurrentBody = createSurveyBody({ title: "Samtidig skoleundersøkelse" });
  const concurrentKey = "survey-operations-concurrent-create-0113";

  const concurrent = await Promise.all([
    api(leader.cookie, "POST", adminPath, { key: concurrentKey, body: concurrentBody }),
    api(leader.cookie, "POST", adminPath, { key: concurrentKey, body: concurrentBody }),
  ]);

  assert.ok(concurrent.some((result) => result.status === 201));

  for (const result of concurrent) {
    assert.ok(
      result.status === 201 || result.body?.code === "idempotency.in-flight",
      `concurrent create must be accepted or in flight, received ${result.status}`,
    );
  }

  const recoveredConcurrent = await api(leader.cookie, "POST", adminPath, {
    key: concurrentKey,
    body: concurrentBody,
  });

  assert.equal(recoveredConcurrent.status, 201);
  const afterConcurrent = await counts();
  assert.deepEqual(afterConcurrent, {
    ...beforeConcurrent,
    surveys: beforeConcurrent.surveys + 1,
    audit: beforeConcurrent.audit + 1,
    receipts: beforeConcurrent.receipts + 1,
  });

  await leader.page.reload();
  await leader.page.getByRole("heading", { name: "Undersøkelser" }).waitFor();
  await leader.page
    .locator(`tr[data-survey-id="${confidential.body.surveyId}"]`)
    .getByRole("button", { name: "Åpne" })
    .click();
  await leader.page.getByRole("heading", { name: unbrokenTitle }).waitFor();
  await leader.page.locator(`tr[data-survey-id="${surveyId}"]`).waitFor();

  const desktopAxe = await new AxeBuilder({ page: leader.page })
    .include('section[aria-labelledby="school-surveys-page-title"]')
    .analyze();

  assert.equal(desktopAxe.violations.length, 0, JSON.stringify(desktopAxe.violations, null, 2));

  const desktopOverflow = await leader.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );

  assert.ok(desktopOverflow <= 0, `desktop horizontal overflow: ${desktopOverflow}`);
  await leader.page.setViewportSize({ width: 390, height: 844 });

  const mobileTitleOverflow = await leader.page
    .locator("#school-surveys-detail-title")
    .evaluate((element) => element.scrollWidth - element.clientWidth);

  assert.ok(
    mobileTitleOverflow <= 0,
    `390px unbroken survey title overflow: ${mobileTitleOverflow}`,
  );

  const mobileOverflow = await leader.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );

  assert.ok(mobileOverflow <= 0, `390px horizontal overflow: ${mobileOverflow}`);
  assert.equal(pageErrors.length, 0);

  for (const session of [leader, foreignLeader, ordinary, inactive, administrator]) {
    await session.context.close();
  }

  return {
    browserCreateThenPublicResponse: true,
    resultsAndCsv: true,
    closedPublicConcealedWithoutWrite: true,
    authorities: {
      anonymous: true,
      ordinary: true,
      inactive: true,
      wrongDepartment: true,
      confidentialResults: true,
    },
    validationReplayAndConcurrency: true,
    staleAndRepeatedClose: true,
    reload: true,
    accessibility: {
      keyboard: true,
      violations: desktopAxe.violations.length,
      desktopOverflow,
      mobileOverflow,
      mobileTitleOverflow,
    },
    finalCounts: await counts(),
    pageErrors,
  };
};

const initialRevision = run("git", ["rev-parse", "HEAD"], {
  label: "0113 source revision",
}).stdout.trim();

assert.notEqual(initialRevision, "");

assert.equal(
  run("git", ["status", "--short"], { label: "0113 source cleanliness" }).stdout.trim(),
  "",
  "0113 runtime must start from a clean tree",
);

const temporaryRoot = await mkdtemp(join(tmpdir(), "native-survey-operations-0113-"));

const postgresData = join(temporaryRoot, "postgres");

const ledger = [];

let postgres;

let backend;

let dashboard;

let proxy;

let browser;

let journey;

let version;

let primaryError;

let cleanupError;

let cleanupPromise;

const cleanupRuntime = () => {
  if (cleanupPromise !== undefined) return cleanupPromise;
  cleanupPromise = (async () => {
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
    await cleanup(() => stop(dashboard));
    await cleanup(() => closeServer(proxy));
    await cleanup(() => stop(backend));
    await cleanup(() => stop(postgres));
    await cleanup(() => rm(temporaryRoot, { recursive: true, force: true }));
    await cleanup(() =>
      Promise.all([postgresPort, backendPort, proxyPort, dashboardPort].map(assertPortAvailable)),
    );

    if (cleanupFailures.length > 0) {
      cleanupError =
        cleanupFailures.length === 1
          ? cleanupFailures[0]
          : new AggregateError(cleanupFailures, "0113 cleanup failed");
    }
  })();

  return cleanupPromise;
};

let terminationStarted = false;

const terminateAfterCleanup = (signal) => {
  if (terminationStarted) return;
  terminationStarted = true;
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  void cleanupRuntime().finally(() => process.kill(process.pid, signal));
};

const onSigint = () => terminateAfterCleanup("SIGINT");

const onSigterm = () => terminateAfterCleanup("SIGTERM");

process.once("SIGINT", onSigint);

process.once("SIGTERM", onSigterm);

try {
  await Promise.all([postgresPort, backendPort, proxyPort, dashboardPort].map(assertPortAvailable));
  run(
    "initdb",
    ["-D", postgresData, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"],
    { label: "0113 PostgreSQL initialization" },
  );
  postgres = start(
    "postgres",
    ["-D", postgresData, "-p", String(postgresPort), "-h", "127.0.0.1", "-k", temporaryRoot],
    { cwd: repositoryRoot, env: process.env, label: "0113 PostgreSQL" },
  );
  await waitForPort(postgresPort, "0113 PostgreSQL startup", postgres);
  run(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres", "survey_operations_e2e_0113"],
    { label: "0113 database creation" },
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
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
    ADMISSION_AUTH_TOKENS: "{}",
    RECEIPT_AUTH_TOKENS: "{}",
    ORGANIZATION_AUTH_TOKENS: "{}",
  };

  backend = start("bun", ["run", "src/main.ts"], {
    cwd: backendRoot,
    env: backendEnvironment,
    label: "0113 native backend",
  });
  await waitForHttp(`${backendOrigin}/health`, "0113 native backend startup", backend);
  run("bun", ["run", "identity:seed"], {
    cwd: databaseRoot,
    env: {
      ...backendEnvironment,
      IDENTITY_SEED_PG_URL: postgresUrl,
      IDENTITY_SEED_PERSONS: JSON.stringify(identitySeedPersons),
    },
    label: "0113 deterministic identity seed",
  });
  await query(seedSql);
  version = (await query("SHOW server_version")).rows[0].server_version;
  proxy = await startRecordingProxy(ledger);
  await waitForHttp(`${apiOrigin}/health`, "0113 recording proxy startup");

  const dashboardEnvironment = {
    ...process.env,
    API_URL: apiOrigin,
    VITE_API_URL: apiOrigin,
    DASHBOARD_MOUNT: "/",
    DASHBOARD_ORIGIN: dashboardOrigin,
    HOST: "127.0.0.1",
    PORT: String(dashboardPort),
    NODE_ENV: "production",
  };

  run("bun", ["run", "build"], {
    cwd: sdkRoot,
    env: dashboardEnvironment,
    label: "0113 generated SDK build",
  });
  run("bun", ["run", "build"], {
    cwd: dashboardRoot,
    env: dashboardEnvironment,
    label: "0113 dashboard production build",
  });
  dashboard = start("bun", ["server.mjs"], {
    cwd: dashboardRoot,
    env: dashboardEnvironment,
    label: "0113 dashboard",
  });
  await waitForHttp(`${dashboardOrigin}/login`, "0113 dashboard startup", dashboard);
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      "/etc/profiles/per-user/nori/bin/chromium-browser",
  });
  journey = await exerciseJourney({ browser, ledger });
} catch (cause) {
  primaryError = cause;

  if (backend !== undefined) process.stderr.write(`Backend tail:\n${backend.output.join("")}\n`);
  process.stderr.write(`Native transport tail:\n${JSON.stringify(ledger.slice(-10), null, 2)}\n`);

  if (dashboard !== undefined)
    process.stderr.write(`Dashboard tail:\n${dashboard.output.join("")}\n`);
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  await cleanupRuntime();
}

if (primaryError !== undefined && cleanupError !== undefined) {
  throw new AggregateError([primaryError, cleanupError], "0113 journey and cleanup failed");
}

if (primaryError !== undefined) throw primaryError;

if (cleanupError !== undefined) throw cleanupError;

const checksum = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const manifest = {
  specId: "0113",
  result: "passed",
  runtimeRevision: initialRevision,
  command: "bun --cwd apps/dashboard e2e:real-survey-operations",
  topology: {
    database: version,
    backend: "native Effect HTTP API",
    sdk: "generated @vektorprogrammet/sdk",
    dashboard: "apps/dashboard/server.mjs production server and Foldkit custom element",
    browser: "real headless Chromium",
  },
  gates: journey,
  commands: [
    "bun run identity:seed",
    "bun --cwd packages/sdk run build",
    "bun --cwd apps/dashboard run build",
    "bun --cwd apps/dashboard server.mjs",
    "Chromium school-survey operations journey",
  ],
  checksums: {
    runner: await checksum(runnerPath),
    contract: await checksum(contractPath),
  },
  skippedOrUnavailable: [],
  cleanup: {
    postgresRemoved: true,
    temporaryRootRemoved: true,
    portsReleased: [postgresPort, backendPort, proxyPort, dashboardPort],
    productionResourcesUsed: false,
  },
};

await mkdir(dirname(manifestPath), { recursive: true });

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

await chmod(manifestPath, 0o600);

process.stdout.write(`${JSON.stringify(manifest)}\n`);
