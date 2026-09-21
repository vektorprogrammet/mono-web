import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import pg from "pg";

const { Client } = pg;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardRoot = fileURLToPath(new URL("../", import.meta.url));
const backendRoot = fileURLToPath(new URL("../../backend/", import.meta.url));
const databaseRoot = fileURLToPath(new URL("../../../packages/database/", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../../packages/sdk/", import.meta.url));
const runnerPath = fileURLToPath(import.meta.url);
const specPath = join(repositoryRoot, "design-specs/0110-native-social-event-creation.md");
const manifestPath = join(
  repositoryRoot,
  "evidence/functional-parity/0110/acceptance-manifest.json",
);
const postgresPort = 45310;
const backendPort = 45311;
const proxyPort = 45312;
const dashboardPort = 5174;
const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/social_events_e2e_0110`;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const apiOrigin = `http://127.0.0.1:${proxyPort}`;
const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
const betterAuthSecret = randomBytes(32).toString("base64url");
const password = "social-events-0110-password-0123456789";
const ids = {
  departmentA: "department-social-events-a-0110",
  departmentB: "department-social-events-b-0110",
  teamA: "team-social-events-a-0110",
  teamB: "team-social-events-b-0110",
  semesterA: "semester-social-events-a-0110",
  semesterB: "semester-social-events-b-0110",
  memberMembership: "membership-social-events-member-0110",
};
const personas = {
  member: {
    personId: "person-social-events-member-0110",
    firstName: "Maja",
    lastName: "Medlem",
    email: "member.social-events.0110@example.invalid",
    password,
  },
  secondMember: {
    personId: "person-social-events-second-member-0110",
    firstName: "Bjørn",
    lastName: "Medlem",
    email: "second-member.social-events.0110@example.invalid",
    password,
  },
  inactiveMember: {
    personId: "person-social-events-inactive-0110",
    firstName: "Ina",
    lastName: "Inaktiv",
    email: "inactive.social-events.0110@example.invalid",
    password,
  },
  unaffiliated: {
    personId: "person-social-events-unaffiliated-0110",
    firstName: "Una",
    lastName: "Utenlag",
    email: "unaffiliated.social-events.0110@example.invalid",
    password,
  },
  administrator: {
    personId: "person-social-events-administrator-0110",
    firstName: "Ada",
    lastName: "Administrator",
    email: "administrator.social-events.0110@example.invalid",
    password,
  },
};
const identitySeedPersons = Object.values(personas).map(
  ({ personId, firstName, lastName, email, password: personaPassword }) => ({
    personId,
    firstName,
    lastName,
    email,
    password: personaPassword,
  }),
);
const commandTimeoutMs = 600_000;
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

const waitForHttp = (url, label) =>
  withTimeout(
    (async () => {
      while (true) {
        try {
          const response = await fetch(url);
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

const requestBody = async (request) => {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error("recorded request exceeded 1 MB");
    chunks.push(chunk);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
};

const startRecordingProxy = async (ledger) => {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", apiOrigin);
    const body = await requestBody(request);
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
      requestJson,
      status: 0,
      responseHeaders: {},
      responseJson: null,
    };
    ledger.push(entry);
    try {
      const upstream = await fetch(new URL(request.url ?? "/", backendOrigin), {
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
        if (["connection", "content-length", "set-cookie", "transfer-encoding"].includes(name))
          continue;
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

const waitForDatabaseWait = async (needle, minimum = 1) =>
  withTimeout(
    (async () => {
      while (true) {
        const result = await query(
          `SELECT count(*)::int AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE $1`,
          [`%${needle}%`],
        );
        if (result.rows[0]?.count >= minimum) return;
        await delay(25);
      }
    })(),
    10_000,
    `database wait for ${needle}`,
  );

const setMemberActive = async (active) => {
  await query(
    `UPDATE organization_memberships
        SET end_at = CASE WHEN $1::boolean THEN NULL ELSE clock_timestamp() - interval '1 millisecond' END,
            revision = revision + 1
      WHERE membership_id = $2`,
    [active, ids.memberMembership],
  );
};

const counts = async () => {
  const result = await query(`
    SELECT
      (SELECT count(*)::int FROM social_events) AS events,
      (SELECT count(*)::int FROM social_event_command_receipts) AS receipts,
      (SELECT count(*)::int FROM social_event_audit) AS audits,
      (SELECT count(*)::int FROM native_http_idempotency_receipts
        WHERE operation_id = 'social-events.create') AS http_receipts
  `);
  return result.rows[0];
};

const signIn = async (browser, persona) => {
  const context = await browser.newContext({ baseURL: dashboardOrigin });
  const page = await context.newPage();
  await page.goto("/dashboard/login");
  await page.getByLabel("E-post").fill(persona.email);
  await page.getByLabel("Passord", { exact: true }).fill(persona.password);
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  await page.waitForURL((url) => url.pathname === "/dashboard/", { timeout: 15_000 });
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

const api = async (cookie, method, path, { body, key } = {}) => {
  const request = {
    method,
    headers: {
      cookie,
      origin: dashboardOrigin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    redirect: "manual",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const response = await fetch(`${apiOrigin}${path}`, request);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: bytes.length === 0 ? null : JSON.parse(bytes.toString("utf8")),
    bytes,
  };
};

const createBody = (overrides = {}) => ({
  departmentId: ids.departmentA,
  semesterId: ids.semesterA,
  audience: "TeamMembers",
  title: "Arrangement",
  description: "Beskrivelse",
  link: "https://example.invalid/arrangement",
  startAt: "2030-02-01T18:00:00.000Z",
  endAt: "2030-02-01T20:00:00.000Z",
  ...overrides,
});

const createEvent = (cookie, key, overrides) =>
  api(cookie, "POST", "/api/social-events", { key, body: createBody(overrides) });

const listEvents = (cookie, departmentId = ids.departmentA, semesterId = ids.semesterA) =>
  api(
    cookie,
    "GET",
    `/api/social-events?departmentId=${encodeURIComponent(departmentId)}&semesterId=${encodeURIComponent(semesterId)}`,
  );

const assertProblem = (response, status, code) => {
  assert.equal(response.status, status);
  assert.equal(response.body?.status, status);
  assert.equal(response.body?.code, code);
  assert.match(response.headers["content-type"] ?? "", /^application\/problem\+json/u);
};

const isoAround = (instant, milliseconds) =>
  new Date(new Date(instant).getTime() + milliseconds).toISOString();

const localDateTime = (instant) => {
  const date = new Date(instant);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const checksum = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const seedSql = `
BEGIN;
INSERT INTO person_contact_profiles (person_id, email, phone, revision)
VALUES
  ('${personas.member.personId}', '${personas.member.email}', '+47 900 01 100', 0),
  ('${personas.secondMember.personId}', '${personas.secondMember.email}', '+47 900 01 101', 0),
  ('${personas.inactiveMember.personId}', '${personas.inactiveMember.email}', '+47 900 01 102', 0),
  ('${personas.unaffiliated.personId}', '${personas.unaffiliated.email}', '+47 900 01 103', 0),
  ('${personas.administrator.personId}', '${personas.administrator.email}', '+47 900 01 104', 0)
ON CONFLICT (person_id) DO NOTHING;
INSERT INTO organization_departments
  (department_id, name, short_name, email, city, active, revision)
VALUES
  ('${ids.departmentA}', 'Trondheim', 'Trondheim', 'trondheim@example.invalid', 'Trondheim', TRUE, 0),
  ('${ids.departmentB}', 'Bergen', 'Bergen', 'bergen@example.invalid', 'Bergen', TRUE, 0);
INSERT INTO organization_teams (team_id, department_id, name, active, revision)
VALUES
  ('${ids.teamA}', '${ids.departmentA}', 'Trondheim team', TRUE, 0),
  ('${ids.teamB}', '${ids.departmentB}', 'Bergen team', TRUE, 0);
INSERT INTO organization_memberships
  (membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
   position_id, is_team_leader, is_suspended, revision)
VALUES
  ('${ids.memberMembership}', '${personas.member.personId}', '${ids.teamA}', NULL,
   '2020-01-01T00:00:00.000Z', NULL, 'member', FALSE, FALSE, 0),
  ('membership-social-events-second-0110', '${personas.secondMember.personId}', '${ids.teamB}', NULL,
   '2020-01-01T00:00:00.000Z', NULL, 'member', FALSE, FALSE, 0),
  ('membership-social-events-inactive-0110', '${personas.inactiveMember.personId}', '${ids.teamA}', NULL,
   '2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z', 'member', FALSE, FALSE, 0);
INSERT INTO organization_global_administrator_grants
  (grant_id, person_id, start_at, end_at, revision)
VALUES
  ('global-administrator-social-events-0110', '${personas.administrator.personId}',
   '2020-01-01T00:00:00.000Z', NULL, 0);
INSERT INTO admission_period_semesters (semester_id, start_at, end_at)
VALUES
  ('${ids.semesterA}', statement_timestamp() - interval '30 days',
   statement_timestamp() + interval '1 year'),
  ('${ids.semesterB}', '2010-01-01T00:00:00.000Z', '2010-06-30T23:59:59.000Z');
COMMIT;
`;

const exerciseJourney = async ({ browser, ledger }) => {
  const member = await signIn(browser, personas.member);
  const inactive = await signIn(browser, personas.inactiveMember);
  const unaffiliated = await signIn(browser, personas.unaffiliated);
  const administrator = await signIn(browser, personas.administrator);
  const pageErrors = [];
  member.page.on("pageerror", (error) => pageErrors.push(error.message));

  const memberScope = await api(member.cookie, "GET", "/api/social-events/scope");
  assert.equal(memberScope.status, 200);
  assert.deepEqual(
    memberScope.body.departments.map(({ departmentId }) => departmentId),
    [ids.departmentA],
  );
  assert.deepEqual(
    memberScope.body.semesters.map(({ semesterId }) => semesterId),
    [ids.semesterA, ids.semesterB],
  );
  const referenceInstant = memberScope.body.observedAt;

  await member.page.goto("/dashboard/arrangementer");
  await member.page.getByRole("heading", { name: "Arrangementer" }).waitFor();
  assert.ok(
    (await member.page.getByRole("link", { name: "Arrangementer" }).count()) > 0,
    "the rendered dashboard navigation exposes Arrangementer",
  );
  await member.page
    .locator("#social-events-department option")
    .filter({ hasText: "Trondheim" })
    .waitFor({ state: "attached" });
  const departmentOptions = await member.page
    .locator("#social-events-department option")
    .allTextContents();
  assert.deepEqual(departmentOptions, ["Velg avdeling", "Trondheim"]);
  assert.equal(await member.page.locator("#social-events-semester option").count(), 3);
  await member.page.selectOption("#social-events-department", ids.departmentA);
  await member.page.selectOption("#social-events-semester", ids.semesterA);
  await member.page.getByRole("heading", { name: "Ingen arrangementer" }).waitFor();

  const firstStart = isoAround(referenceInstant, 24 * 60 * 60 * 1000);
  const firstEnd = isoAround(referenceInstant, 26 * 60 * 60 * 1000);
  await member.page.selectOption("#social-events-audience", "TeamMembers");
  await member.page.fill("#social-events-title", "Sosial kveld");
  await member.page.fill("#social-events-description", "Brettspill og pizza");
  await member.page.fill("#social-events-link", "https://example.invalid/sosial-kveld");
  await member.page.fill("#social-events-start", localDateTime(firstStart));
  await member.page.fill("#social-events-end", localDateTime(firstEnd));
  await member.page.getByRole("button", { name: "Lagre arrangement" }).click();
  await member.page.getByText("Arrangementlisten er oppdatert fra serveren.").waitFor();
  const firstRow = member.page.locator("tr[data-event-id]").filter({ hasText: "Sosial kveld" });
  await firstRow.waitFor();
  assert.equal(await firstRow.getByText("Brettspill og pizza").count(), 1);
  assert.equal(await firstRow.getByText("https://example.invalid/sosial-kveld").count(), 1);
  assert.match(await firstRow.innerText(), /Kun teammedlemmer/u);

  const firstUiPost = ledger.find(
    ({ method, path, requestJson }) =>
      method === "POST" && path === "/api/social-events" && requestJson?.title === "Sosial kveld",
  );
  assert.ok(firstUiPost, "dashboard create reached the native API");
  assert.equal(firstUiPost.status, 201);
  assert.equal(firstUiPost.responseHeaders["cache-control"], "no-store");
  assert.equal(firstUiPost.responseHeaders.vary, "Origin");
  assert.match(firstUiPost.responseHeaders.etag ?? "", /^"vkr2\.[A-Za-z0-9_-]{43}"$/u);
  assert.match(firstUiPost.responseHeaders.location ?? "", /^\/api\/social-events\//u);
  const firstPostIndex = ledger.indexOf(firstUiPost);
  assert.ok(
    ledger
      .slice(firstPostIndex + 1)
      .some(
        ({ method, path, status }) =>
          method === "GET" && path === "/api/social-events" && status === 200,
      ),
    "dashboard fetched a fresh scoped list after create",
  );

  await member.page.selectOption("#social-events-audience", "AssistantsAndTeamMembers");
  await member.page.fill("#social-events-title", "Åpen sosialkveld");
  await member.page.fill("#social-events-description", "");
  await member.page.fill("#social-events-link", "");
  await member.page.fill(
    "#social-events-start",
    localDateTime(isoAround(referenceInstant, 48 * 60 * 60 * 1000)),
  );
  await member.page.fill(
    "#social-events-end",
    localDateTime(isoAround(referenceInstant, 50 * 60 * 60 * 1000)),
  );
  await member.page.getByRole("button", { name: "Lagre arrangement" }).click();
  await member.page.getByText("Arrangementlisten er oppdatert fra serveren.").waitFor();
  const widerRow = member.page.locator("tr[data-event-id]").filter({ hasText: "Åpen sosialkveld" });
  await widerRow.waitFor();
  assert.match(await widerRow.innerText(), /Ingen beskrivelse/u);
  assert.match(await widerRow.innerText(), /Ingen lenke/u);
  assert.match(await widerRow.innerText(), /Teammedlemmer og assistenter/u);

  const sameStart = isoAround(referenceInstant, 72 * 60 * 60 * 1000);
  const equalA = await createEvent(member.cookie, "social-events-equal-a-0110", {
    title: "Lik tid A",
    startAt: sameStart,
    endAt: isoAround(sameStart, 60 * 60 * 1000),
  });
  const equalB = await createEvent(member.cookie, "social-events-equal-b-0110", {
    title: "Lik tid B",
    startAt: sameStart,
    endAt: isoAround(sameStart, 60 * 60 * 1000),
  });
  assert.equal(equalA.status, 201);
  assert.equal(equalB.status, 201);

  const boundaryDefinitions = [
    ["Før nå", -1],
    ["Ved nå", 0],
    ["Etter nå", 1],
    ["Før syv dager", 7 * 24 * 60 * 60 * 1000 - 1],
    ["Ved syv dager", 7 * 24 * 60 * 60 * 1000],
    ["Etter syv dager", 7 * 24 * 60 * 60 * 1000 + 1],
    ["Godt etter syv dager", 8 * 24 * 60 * 60 * 1000],
  ];
  for (const [title, offset] of boundaryDefinitions) {
    const startAt = isoAround(referenceInstant, offset);
    const created = await createEvent(
      member.cookie,
      `social-events-boundary-${String(offset).replace("-", "n")}-0110`,
      {
        title,
        link: null,
        startAt,
        endAt: isoAround(startAt, 1),
      },
    );
    assert.equal(created.status, 201, `create ${title}`);
  }
  const listed = await listEvents(member.cookie);
  assert.equal(listed.status, 200);
  const equalRows = listed.body.events.filter(({ startAt }) => startAt === sameStart);
  assert.deepEqual(
    equalRows.map(({ eventId }) => eventId),
    [equalA.body.eventId, equalB.body.eventId].sort(),
  );

  const { timeLabel } = await import("../app/foldkit/social-events/view.ts");
  assert.equal(timeLabel(isoAround(referenceInstant, -1), referenceInstant), "Har vært");
  assert.equal(timeLabel(referenceInstant, referenceInstant), "Skjer innen en uke");
  assert.equal(
    timeLabel(isoAround(referenceInstant, 7 * 24 * 60 * 60 * 1000 - 1), referenceInstant),
    "Skjer innen en uke",
  );
  assert.equal(
    timeLabel(isoAround(referenceInstant, 7 * 24 * 60 * 60 * 1000), referenceInstant),
    null,
  );
  assert.equal(
    timeLabel(isoAround(referenceInstant, 7 * 24 * 60 * 60 * 1000 + 1), referenceInstant),
    null,
  );

  const replay = await api(member.cookie, "POST", "/api/social-events", {
    key: firstUiPost.idempotencyKey,
    body: firstUiPost.requestJson,
  });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, firstUiPost.responseJson);
  assert.equal(replay.headers.etag, firstUiPost.responseHeaders.etag);
  assert.equal(replay.headers.location, firstUiPost.responseHeaders.location);
  const afterReplay = await counts();

  const locker = await connect();
  await locker.query("BEGIN");
  await locker.query("LOCK TABLE social_events IN ACCESS EXCLUSIVE MODE");
  const raceBody = createBody({ title: "Samtidig arrangement", link: null });
  const raceKey = "social-events-race-0110";
  const raceOne = api(member.cookie, "POST", "/api/social-events", {
    key: raceKey,
    body: raceBody,
  });
  await waitForDatabaseWait("INSERT INTO public.social_events");
  const raceTwo = api(member.cookie, "POST", "/api/social-events", {
    key: raceKey,
    body: raceBody,
  });
  const quickRace = await withTimeout(raceTwo, 10_000, "matching command in-flight response");
  assertProblem(quickRace, 409, "idempotency.in-flight");
  assert.equal(quickRace.headers["retry-after"], "1");
  await locker.query("COMMIT");
  await locker.end();
  const acceptedRace = await raceOne;
  assert.equal(acceptedRace.status, 201);

  const digestCounts = await counts();
  const changedReplay = await api(member.cookie, "POST", "/api/social-events", {
    key: raceKey,
    body: { ...raceBody, title: "Endret samtidig arrangement" },
  });
  assertProblem(changedReplay, 409, "idempotency.digest-conflict");
  assert.deepEqual(await counts(), digestCounts);

  const tombKey = "social-events-tombstone-0110";
  const tombCreated = await createEvent(member.cookie, tombKey, { title: "Utløpt svar" });
  assert.equal(tombCreated.status, 201);
  await query(
    `UPDATE native_http_idempotency_receipts
        SET committed_at = committed_at - interval '25 hours',
            full_expires_at = full_expires_at - interval '25 hours'
      WHERE operation_id = 'social-events.create'
        AND convert_from(body_bytes, 'UTF8')::jsonb ->> 'eventId' = $1`,
    [tombCreated.body.eventId],
  );
  const tombCounts = await counts();
  const tombReplay = await createEvent(member.cookie, tombKey, { title: "Utløpt svar" });
  assertProblem(tombReplay, 409, "idempotency.response-expired");
  assert.deepEqual(await counts(), tombCounts);

  const beforeValidation = await counts();
  const invalidTime = await createEvent(member.cookie, "social-events-invalid-time-0110", {
    title: "Ugyldig tid",
    startAt: "2030-03-01T20:00:00.000Z",
    endAt: "2030-03-01T19:00:00.000Z",
  });
  assertProblem(invalidTime, 422, "validation.failed");
  assert.deepEqual(await counts(), beforeValidation);

  const beforeAuthority = await counts();
  assertProblem(await listEvents(member.cookie, ids.departmentB), 403, "authority.denied");
  assertProblem(
    await createEvent(member.cookie, "social-events-other-department-0110", {
      departmentId: ids.departmentB,
      title: "Ikke tillatt",
    }),
    403,
    "authority.denied",
  );
  for (const persona of [inactive, unaffiliated]) {
    assertProblem(await listEvents(persona.cookie), 403, "authority.denied");
    assertProblem(
      await createEvent(
        persona.cookie,
        `social-events-denied-${persona === inactive ? "inactive" : "unaffiliated"}-0110`,
        {
          title: "Ikke tillatt",
        },
      ),
      403,
      "authority.denied",
    );
  }
  assert.deepEqual(await counts(), beforeAuthority);

  const adminScope = await api(administrator.cookie, "GET", "/api/social-events/scope");
  assert.equal(adminScope.status, 200);
  assert.deepEqual(
    adminScope.body.departments.map(({ departmentId }) => departmentId),
    [ids.departmentB, ids.departmentA],
  );
  assert.equal((await listEvents(administrator.cookie, ids.departmentA)).status, 200);
  assert.equal((await listEvents(administrator.cookie, ids.departmentB)).status, 200);
  const adminCreated = await createEvent(administrator.cookie, "social-events-admin-b-0110", {
    departmentId: ids.departmentB,
    title: "Administrator Bergen",
  });
  assert.equal(adminCreated.status, 201);

  const beforeUnknown = await counts();
  const unknownDepartment = "department-social-events-unknown-0110";
  const unknownSemester = "semester-social-events-unknown-0110";
  assert.equal((await listEvents(member.cookie, unknownDepartment)).status, 403);
  assertProblem(
    await listEvents(member.cookie, ids.departmentA, unknownSemester),
    422,
    "scope.invalid",
  );
  assert.equal(
    (
      await createEvent(member.cookie, "social-events-unknown-department-0110", {
        departmentId: unknownDepartment,
      })
    ).status,
    403,
  );
  assertProblem(
    await createEvent(member.cookie, "social-events-unknown-semester-0110", {
      semesterId: unknownSemester,
    }),
    422,
    "scope.invalid",
  );
  assert.deepEqual(await counts(), beforeUnknown);

  const beforeSnapshotCounts = await counts();
  await setMemberActive(false);
  assertProblem(await listEvents(member.cookie), 403, "authority.denied");
  assert.deepEqual(await counts(), beforeSnapshotCounts);
  await setMemberActive(true);

  const snapshotLocker = await connect();
  await snapshotLocker.query("BEGIN");
  await snapshotLocker.query("LOCK TABLE social_events IN ACCESS EXCLUSIVE MODE");
  const heldListPromise = listEvents(member.cookie);
  await waitForDatabaseWait("FROM public.social_events");
  await setMemberActive(false);
  const laterEventPromise = createEvent(administrator.cookie, "social-events-later-snapshot-0110", {
    title: "Etter snapshot",
  });
  await waitForDatabaseWait("INSERT INTO public.social_events");
  await snapshotLocker.query("COMMIT");
  await snapshotLocker.end();
  const [heldList, laterEvent] = await Promise.all([heldListPromise, laterEventPromise]);
  assert.equal(heldList.status, 200);
  assert.equal(laterEvent.status, 201);
  assert.equal(
    heldList.body.events.some(({ eventId }) => eventId === laterEvent.body.eventId),
    false,
  );
  assertProblem(await listEvents(member.cookie), 403, "authority.denied");

  const beforeCreateBarrier = await counts();
  assertProblem(
    await createEvent(member.cookie, "social-events-revoked-create-0110", {
      title: "Avvist etter sperre",
    }),
    403,
    "authority.denied",
  );
  assert.deepEqual(await counts(), beforeCreateBarrier);
  await setMemberActive(true);

  const revocableKey = "social-events-revocable-replay-0110";
  const revocableBody = createBody({ title: "Opprettet før tilbakekall" });
  const revocable = await api(member.cookie, "POST", "/api/social-events", {
    key: revocableKey,
    body: revocableBody,
  });
  assert.equal(revocable.status, 201);
  await setMemberActive(false);
  const beforeDeniedReplay = await counts();
  assertProblem(
    await api(member.cookie, "POST", "/api/social-events", {
      key: revocableKey,
      body: revocableBody,
    }),
    403,
    "authority.denied",
  );
  assert.deepEqual(await counts(), beforeDeniedReplay);
  await setMemberActive(true);

  await member.page.reload();
  await member.page.getByRole("heading", { name: "Arrangementer" }).waitFor();
  await member.page.selectOption("#social-events-department", ids.departmentA);
  await member.page.selectOption("#social-events-semester", ids.semesterA);
  await member.page.getByText("Sosial kveld").waitFor();
  const reloadedWide = member.page
    .locator("tr[data-event-id]")
    .filter({ hasText: "Åpen sosialkveld" });
  assert.match(await reloadedWide.innerText(), /Ingen beskrivelse/u);
  assert.match(await reloadedWide.innerText(), /Ingen lenke/u);
  const pastRow = member.page.locator("tr[data-event-id]").filter({ hasText: "Før nå" });
  const withinWeekRow = member.page
    .locator("tr[data-event-id]")
    .filter({ hasText: "Sosial kveld" });
  const laterRow = member.page
    .locator("tr[data-event-id]")
    .filter({ hasText: "Godt etter syv dager" });
  assert.equal(await pastRow.getByText("Har vært").count(), 1);
  assert.equal(await withinWeekRow.getByText("Skjer innen en uke").count(), 1);
  assert.equal(await laterRow.locator(".social-events__label").count(), 0);
  assert.equal(pageErrors.length, 0);

  await member.page.locator("#social-events-department").focus();
  await member.page.keyboard.press("Tab");
  assert.equal(
    await member.page
      .locator("#social-events-semester")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  const desktopOverflow = await member.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert.ok(desktopOverflow <= 0, `desktop horizontal overflow: ${desktopOverflow}`);
  await member.page.setViewportSize({ width: 390, height: 844 });
  const mobileOverflow = await member.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert.ok(mobileOverflow <= 0, `mobile horizontal overflow: ${mobileOverflow}`);
  const scrollRegion = member.page.locator(".social-events__table-scroll");
  assert.equal(await scrollRegion.getAttribute("tabindex"), "0");
  await scrollRegion.focus();
  assert.equal(await scrollRegion.evaluate((node) => node === document.activeElement), true);

  const finalCounts = await counts();
  assert.equal(finalCounts.events, finalCounts.receipts);
  assert.equal(finalCounts.events, finalCounts.audits);
  assert.equal(finalCounts.events, finalCounts.http_receipts);
  assert.ok(finalCounts.events > afterReplay.events);

  const immutableClient = await connect();
  try {
    await assert.rejects(
      immutableClient.query(
        "UPDATE social_event_command_receipts SET actor_person_id = actor_person_id",
      ),
      /immutable/u,
    );
    await assert.rejects(
      immutableClient.query("UPDATE social_event_audit SET action = action"),
      /immutable/u,
    );
  } finally {
    await immutableClient.end();
  }

  for (const session of [member, inactive, unaffiliated, administrator])
    await session.context.close();
  return {
    scope: { memberDepartments: [ids.departmentA], semesters: [ids.semesterA, ids.semesterB] },
    exactCreateHeaders: firstUiPost.responseHeaders,
    postThenGet: true,
    replay: { status: replay.status, eventId: replay.body.eventId },
    race: { accepted: acceptedRace.status, inFlight: quickRace.status },
    negativeCases: {
      digestConflict: changedReplay.status,
      responseExpired: tombReplay.status,
      invalidTime: invalidTime.status,
      crossDepartment: 403,
      inactive: 403,
      unaffiliated: 403,
      unknownScopeNoWrite: true,
      revocationBeforeSnapshot: 403,
      revocationAfterSnapshot: heldList.status,
      revokedCreate: 403,
      revokedReplay: 403,
    },
    ordering: equalRows.map(({ eventId }) => eventId),
    exactBoundaryLabels: true,
    reloadFromServer: true,
    accessibility: { keyboard: true, desktopOverflow, mobileOverflow },
    finalCounts,
    pageErrors,
  };
};

const version = run("postgres", ["--version"], { label: "PostgreSQL version" }).stdout.trim();
assert.match(version, /PostgreSQL\) 17\./u, "0110 requires PostgreSQL 17");
const initialRevision = run("git", ["rev-parse", "HEAD"], {
  label: "runtime revision",
}).stdout.trim();
assert.equal(
  run("git", ["status", "--porcelain"], { label: "clean runtime tree" }).stdout,
  "",
  "0110 runtime must start from a clean tree",
);

const temporaryRoot = await mkdtemp(join(tmpdir(), "native-social-events-0110-"));
const postgresData = join(temporaryRoot, "postgres");
const ledger = [];
let postgres;
let backend;
let dashboard;
let proxy;
let browser;
let journey;
let primaryError;
let cleanupError;

try {
  await Promise.all([postgresPort, backendPort, proxyPort, dashboardPort].map(assertPortAvailable));
  run(
    "initdb",
    ["-D", postgresData, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"],
    {
      label: "0110 PostgreSQL initialization",
    },
  );
  postgres = start(
    "postgres",
    ["-D", postgresData, "-p", String(postgresPort), "-h", "127.0.0.1", "-k", temporaryRoot],
    { cwd: repositoryRoot, env: process.env, label: "0110 PostgreSQL" },
  );
  await waitForPort(postgresPort, "0110 PostgreSQL startup");
  run(
    "createdb",
    ["-h", "127.0.0.1", "-p", String(postgresPort), "-U", "postgres", "social_events_e2e_0110"],
    {
      label: "0110 database creation",
    },
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
    label: "0110 native backend",
  });
  await waitForHttp(`${backendOrigin}/health`, "0110 native backend startup");
  run("bun", ["run", "identity:seed"], {
    cwd: databaseRoot,
    env: {
      ...backendEnvironment,
      IDENTITY_SEED_PG_URL: postgresUrl,
      IDENTITY_SEED_PERSONS: JSON.stringify(identitySeedPersons),
    },
    label: "0110 deterministic identity seed",
  });
  await query(seedSql);
  proxy = await startRecordingProxy(ledger);
  await waitForHttp(`${apiOrigin}/health`, "0110 recording proxy startup");

  const dashboardEnvironment = {
    ...process.env,
    API_URL: apiOrigin,
    VITE_API_URL: apiOrigin,
    DASHBOARD_ORIGIN: dashboardOrigin,
    HOST: "127.0.0.1",
    PORT: String(dashboardPort),
    NODE_ENV: "production",
  };
  run("bun", ["run", "build"], {
    cwd: sdkRoot,
    env: dashboardEnvironment,
    label: "0110 generated SDK build",
  });
  run("bun", ["run", "build"], {
    cwd: dashboardRoot,
    env: dashboardEnvironment,
    label: "0110 dashboard production build",
  });
  dashboard = start(
    process.env.PLAYWRIGHT_NODE_EXECUTABLE ?? "node",
    ["node_modules/@react-router/serve/dist/cli.js", "build/server/index.js"],
    { cwd: dashboardRoot, env: dashboardEnvironment, label: "0110 dashboard" },
  );
  await waitForHttp(`${dashboardOrigin}/dashboard/login`, "0110 dashboard startup");
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
  try {
    if (browser !== undefined) await browser.close();
    await stop(dashboard);
    await closeServer(proxy);
    await stop(backend);
    await stop(postgres);
    await rm(temporaryRoot, { recursive: true, force: true });
    await Promise.all(
      [postgresPort, backendPort, proxyPort, dashboardPort].map(assertPortAvailable),
    );
  } catch (cause) {
    cleanupError = cause;
  }
}

if (primaryError !== undefined && cleanupError !== undefined) {
  throw new AggregateError([primaryError, cleanupError], "0110 journey and cleanup failed");
}
if (primaryError !== undefined) throw primaryError;
if (cleanupError !== undefined) throw cleanupError;

const manifest = {
  specId: "0110",
  result: "passed",
  runtimeRevision: initialRevision,
  command: "bun --cwd apps/dashboard e2e/run-real-native-social-events.mjs",
  topology: {
    database: version,
    backend: "native Effect HTTP API",
    sdk: "generated @vektorprogrammet/sdk",
    dashboard: "production React Router server",
    browser: "real headless Chromium",
  },
  gates: {
    seededAuthoritiesAndScopes: true,
    dashboardCreateReload: true,
    exactHttpContract: true,
    orderingAndHalfOpenLabels: true,
    idempotencyAndConcurrency: true,
    authorityAndUnknownScopeCounterexamples: true,
    snapshotRevocation: true,
    databaseAtomicityAndImmutability: true,
    responsiveKeyboardSurface: true,
  },
  observedRuntime: journey,
  commands: [
    "bun run identity:seed",
    "bun --cwd packages/sdk run build",
    "bun --cwd apps/dashboard run build",
    "Chromium social-event journey",
  ],
  checksums: {
    runner: await checksum(runnerPath),
    designSpec: await checksum(specPath),
  },
  negativeCases: journey.negativeCases,
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
