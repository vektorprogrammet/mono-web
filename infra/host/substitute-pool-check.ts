import { createPromiseClient } from "../../packages/sdk/src/promise.js";
/** 0094 real local API + browser acceptance. Reuses native identity seed and owned process lifecycle. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { stopPreviewScenarioBackend } from "./preview-scenario.js";
const root = new URL("../../", import.meta.url).pathname;
const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
const { Pool } = requireDatabase("pg");
const run = (command: string, args: string[], env = process.env, timeout = 60_000) =>
  execFileSync(command, args, { cwd: root, env, encoding: "utf8", timeout });
const revision = run("git", ["rev-parse", "HEAD"]).trim();
assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "requires committed clean artifact");
const artifacts = await mkdtemp(join(tmpdir(), "vektor-substitutes-0094-"));
const children: ReturnType<typeof spawn>[] = [];
const outputs: string[] = [];
const start = (command: string, args: string[], env = process.env) => {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout?.on("data", (chunk) => outputs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => outputs.push(String(chunk)));
  return child;
};
const port = async (requested = 0): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requested, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const value = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pool: InstanceType<typeof Pool> | undefined;
let evidence: Record<string, unknown> | undefined;
try {
  const pgPort = await port();
  const backendPort = await port();
  const dashboardPort = await port(5174);
  const pgDir = join(artifacts, "postgres");
  run("initdb", ["-D", pgDir, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"]);
  start("postgres", ["-D", pgDir, "-p", String(pgPort), "-h", "127.0.0.1", "-k", artifacts]);
  const postgresUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
  pool = new Pool({ connectionString: postgresUrl });
  for (let n = 0; ; n++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (e) {
      if (n > 100) throw e;
      await delay(100);
    }
  }
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
  const environment = {
    ...process.env,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: postgresUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
    OAUTH_CANONICAL_ORIGIN: backendOrigin,
    OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    JOURNEY_SEED_PG_URL: postgresUrl,
  };
  for (const key of Object.keys(environment))
    if (
      key.startsWith("CONTACT_") ||
      (key.startsWith("PUBLIC_APPLICATION_EFFECT_") && key !== "PUBLIC_APPLICATION_EFFECT_MODE")
    )
      delete environment[key as keyof typeof environment];
  run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], environment);
  const departmentId = "department-native-journey-0049",
    semesterId = "semester-historical-0094",
    secondSemesterId = "semester-native-journey-0049",
    noPeriodSemesterId = "semester-no-period-0094";
  await pool.query(`INSERT INTO public.admission_period_semesters(semester_id,start_at,end_at) VALUES ('${semesterId}','2024-01-01','2024-07-01'),('${noPeriodSemesterId}','2023-01-01','2023-07-01');
 INSERT INTO public.admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,revision,last_command_id) VALUES ('period-historical-0094','${departmentId}','${semesterId}','2024-01-01','2024-06-01',0,'fixture-0094');
 INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision)
 SELECT 'application-browser-0094',applicant_id,'period-historical-0094',department_id,field_of_study_id,year_of_study,'2024-01-02',0 FROM public.admission_applications WHERE application_id='application-native-journey-0049';
 INSERT INTO public.organization_departments(department_id,name,short_name,email,city,active,revision) VALUES ('wrong-0094','Annen avdeling','Annen','wrong@example.invalid','Annen',true,0);
 INSERT INTO public.organization_teams(team_id,department_id,name,active,revision) VALUES ('wrong-team-0094','wrong-0094','Annet team',true,0);
 UPDATE public.organization_memberships SET team_id='wrong-team-0094',is_team_leader=true WHERE person_id='journey-rec-interviewer-b-0049';`);
  start("bun", ["run", "--cwd", "apps/backend", "start"], environment);
  for (let n = 0; ; n++) {
    try {
      if ((await fetch(`${backendOrigin}/health`)).ok) break;
    } catch {}
    if (n > 150) throw Error("backend startup failed");
    await delay(200);
  }
  const persons = {
    leader: { email: "lina.leader@example.invalid", password: "journey-secret-0123456789abcdef" },
    member: {
      email: "irene.intervjuer@example.invalid",
      password: "journey-secret-0123456789abcdef",
    },
    wrongDepartment: {
      email: "ida.intervjuer@example.invalid",
      password: "journey-secret-0123456789abcdef",
    },
  };
  const login = async (person: { email: string; password: string }) => {
    const response = await fetch(`${backendOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: dashboardOrigin },
      body: JSON.stringify(person),
    });
    assert.equal(response.status, 200, `login: ${await response.text()}`);
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie);
    return cookie.split(";")[0]!;
  };
  const leader = await login(persons.leader),
    member = await login(persons.member),
    wrong = await login(persons.wrongDepartment);
  const request = async (
    path: string,
    cookie?: string,
    body?: unknown,
    etag?: string,
    key = randomBytes(18).toString("base64url"),
  ) =>
    fetch(`${backendOrigin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: dashboardOrigin,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": key,
              ...(etag ? { "if-match": etag } : {}),
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const sdk = createPromiseClient(backendOrigin, { cookie: leader, origin: dashboardOrigin });
  const sessionResponse = await request("/api/session", leader);
  assert.equal(sessionResponse.headers.get("cache-control"), "private, no-store");
  assert.equal((await sdk.system.readSession()).body.personId, "journey-rec-leader-0049");
  assert.ok((await sdk.system.listSessions()).body.length > 0);
  assert.equal(
    (await sdk.profile.readOwnProfile({ headers: {} })).body?.personId,
    "journey-rec-leader-0049",
  );
  assert.ok((await sdk.substitutes.listScopes()).body.departments.length > 0);
  const submissionKey = randomBytes(18).toString("base64url");
  const submission = {
    departmentId,
    firstName: "Anne",
    lastName: "API",
    phone: "90000094",
    email: "anne.api@example.invalid",
    gender: 1,
    fieldOfStudyId: "field-native-journey-0049",
    yearOfStudy: 3,
  };
  const submitted = await request(
    "/api/applications",
    undefined,
    submission,
    undefined,
    submissionKey,
  );
  assert.equal(submitted.status, 201, await submitted.clone().text());
  const confirmation = await submitted.json();
  const applicationId = confirmation.applicationId,
    path = `/api/substitutes/${applicationId}`;
  assert.equal(typeof applicationId, "string");
  const interview = await request(
    `/api/recruitment/applications/${applicationId}/interviews`,
    leader,
    {
      interviewerPersonId: "journey-rec-interviewer-a-0049",
      interviewSchemaId: "interview-schema-native-journey-0049",
    },
  );
  assert.equal(interview.status, 201, await interview.clone().text());
  const recruitmentBefore = await pool.query(
    "SELECT * FROM public.recruitment_interviews WHERE application_id=$1",
    [applicationId],
  );
  assert.equal(recruitmentBefore.rows.length, 1);

  const body = {
    monday: true,
    tuesday: false,
    wednesday: true,
    thursday: false,
    friday: true,
    language: "Norwegian",
    yearOfStudy: 3,
  };
  const get = async (cookie = leader) => {
    const response = await request(path, cookie);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  await pool.query(
    "INSERT INTO public.organization_memberships(membership_id,person_id,team_id,deleted_team_name,start_at,end_at,position_id,is_team_leader,is_suspended,revision) VALUES ('first-membership-0094','journey-rec-leader-0049','wrong-team-0094',NULL,'2026-01-01',NULL,NULL,false,false,0)",
  );
  const choices = await request("/api/substitutes/scopes", leader);
  assert.equal(choices.status, 200);
  assert.equal(
    (await choices.json()).departments.length,
    2,
    "all requested-department memberships evaluated",
  );
  await pool.query(
    "INSERT INTO public.organization_global_administrator_grants(grant_id,person_id,start_at,end_at,revision) VALUES ('admin-0094','journey-rec-interviewer-b-0049','2026-01-01',NULL,0)",
  );
  assert.equal(
    (await request(path, wrong)).status,
    200,
    "active global administrator sees candidate across departments",
  );
  await pool.query(
    "DELETE FROM public.organization_global_administrator_grants WHERE grant_id='admin-0094'",
  );
  const initial = await get();
  const selectedSdk = await sdk.substitutes.readEntry({ params: { applicationId }, headers: {} });
  assert.equal(selectedSdk.body?.applicationId, applicationId);

  assert.equal(initial.active, false);
  assert.equal(initial.preferences, null);
  for (const cookie of [undefined, wrong]) {
    assert.ok([401, 403].includes((await request(path, cookie)).status));
  }
  assert.equal((await request(path, member)).status, 403, "inactive item private from member");
  const selectedPool = `/api/substitutes?departmentId=${departmentId}&semesterId=${secondSemesterId}`;
  assert.equal((await request(selectedPool, wrong)).status, 403, "wrong department pool denied");
  assert.equal((await request(selectedPool)).status, 401, "anonymous pool denied");
  assert.equal(
    (await request(`${path}?departmentId=wrong-0094`, leader)).status,
    400,
    "forged item scope rejected",
  );
  assert.equal(
    (await request(`${path}:activate`, leader, body)).status,
    428,
    "conditional version required",
  );

  const memberEmpty = await request(selectedPool, member);
  assert.equal(memberEmpty.status, 200);
  const memberBoard = await memberEmpty.json();
  assert.equal(memberBoard._tag, "ReadOnly");
  assert.equal("candidates" in memberBoard, false);
  assert.equal((await request(`${path}:activate`, member, body, initial.etag)).status, 403);
  for (const invalid of [
    { yearOfStudy: 3 },
    { ...body, language: "French" },
    { ...body, yearOfStudy: 0 },
    { ...body, yearOfStudy: "3" },
    { ...body, monday: "true" },
    { ...body, departmentId: "wrong-0094" },
  ])
    assert.equal((await request(`${path}:activate`, leader, invalid, initial.etag)).status, 422);
  assert.equal((await get()).preferences, null, "invalid commands persist no defaults");
  const key = randomBytes(18).toString("base64url");
  const accepted = await request(`${path}:activate`, leader, body, initial.etag, key);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const activated = await accepted.json();
  assert.equal(activated.active, true);
  const retry = await request(`${path}:activate`, leader, body, initial.etag, key);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), activated);
  assert.equal(
    (await request(`${path}:activate`, leader, { ...body, yearOfStudy: 4 }, initial.etag, key))
      .status,
    409,
  );
  assert.equal((await request(`${path}:activate`, leader, body, activated.etag)).status, 400);
  assert.equal(
    (await request(`${path}:edit`, leader, { ...body, yearOfStudy: 4 }, initial.etag)).status,
    412,
  );
  const staleCommand = {
    params: { applicationId },
    headers: { "if-match": initial.etag, "idempotency-key": randomBytes(18).toString("base64url") },
    payload: { ...body, yearOfStudy: 4 },
  };
  for (const attempt of ["initial stale edit", "unchanged rejected retry"]) {
    await assert.rejects(sdk.substitutes.edit(staleCommand), (error: unknown) => {
      const shape =
        error !== null && typeof error === "object"
          ? {
              keys: Object.keys(error),
              body:
                "body" in error && error.body !== null && typeof error.body === "object"
                  ? {
                      keys: Object.keys(error.body),
                      code: "code" in error.body ? error.body.code : null,
                    }
                  : null,
            }
          : { type: typeof error };
      assert.ok(
        error !== null && typeof error === "object" && "code" in error,
        `${attempt}: ${JSON.stringify(shape)}`,
      );
      assert.equal(error.code, "precondition.failed", attempt);
      return true;
    });
  }
  assert.equal((await request(path, member)).status, 200);
  const edits = await Promise.all([
    request(`${path}:edit`, leader, { ...body, yearOfStudy: 4 }, activated.etag),
    request(`${path}:edit`, leader, { ...body, yearOfStudy: 5 }, activated.etag),
  ]);
  assert.equal(
    edits.filter((r) => r.status === 200).length,
    1,
    `concurrent edits ${edits.map((r) => r.status)}`,
  );
  assert.ok(
    edits.some((r) => [409, 412].includes(r.status)),
    `concurrent edit rejection ${edits.map((r) => r.status)}`,
  );
  const edited = await get();
  const submissionReplay = await request(
    "/api/applications",
    undefined,
    submission,
    undefined,
    submissionKey,
  );
  assert.equal(submissionReplay.status, 201);
  assert.deepEqual(
    await submissionReplay.json(),
    confirmation,
    "immutable original submission replay after year update",
  );
  await assert.rejects(
    pool.query("UPDATE public.admission_applications SET revision=-1 WHERE application_id=$1", [
      applicationId,
    ]),
    (error) => error.code === "23514",
  );
  assert.ok([4, 5].includes(edited.yearOfStudy));
  const deactivated = await request(`${path}:deactivate`, leader, {}, edited.etag);
  assert.equal(deactivated.status, 200);
  const inactive = await deactivated.json();
  const recruitmentAfter = await pool.query(
    "SELECT * FROM public.recruitment_interviews WHERE application_id=$1",
    [applicationId],
  );
  assert.deepEqual(
    recruitmentAfter.rows,
    recruitmentBefore.rows,
    "deactivation preserves recruitment history",
  );
  assert.equal(inactive.active, false);
  assert.deepEqual(inactive.preferences, {
    monday: true,
    tuesday: false,
    wednesday: true,
    thursday: false,
    friday: true,
    language: "Norwegian",
  });
  assert.equal((await request(`${path}:edit`, leader, body, inactive.etag)).status, 400);
  assert.equal((await request(`${path}:deactivate`, leader, {}, inactive.etag)).status, 400);
  const unavailable = { ...body, monday: false, wednesday: false, friday: false };
  const concurrent = await Promise.all([
    request(`${path}:activate`, leader, unavailable, inactive.etag),
    request(`${path}:activate`, leader, unavailable, inactive.etag),
  ]);

  assert.equal(
    concurrent.filter((r) => r.status === 200).length,
    1,
    `concurrent activates ${concurrent.map((r) => r.status)}`,
  );
  assert.ok(concurrent.some((r) => [409, 412].includes(r.status)));
  await pool.query(
    "UPDATE public.organization_memberships SET is_suspended=true WHERE person_id='journey-rec-leader-0049'",
  );
  assert.equal(
    (await request(`${path}:activate`, leader, body, initial.etag, key)).status,
    403,
    "revoked authority exact replay denied",
  );
  assert.equal((await request(selectedPool, leader)).status, 403);
  await pool.query(
    "UPDATE public.organization_memberships SET is_suspended=false WHERE person_id='journey-rec-leader-0049'",
  );
  const empty = await request(
    `/api/substitutes?departmentId=${departmentId}&semesterId=${noPeriodSemesterId}`,
    leader,
  );
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).admissionPeriodId, null);
  const count = await pool.query(
    "SELECT count(*)::integer AS count FROM public.admission_substitute_preferences WHERE application_id=$1",
    [applicationId],
  );
  assert.equal(count.rows[0].count, 1);
  const browserCandidate = await pool.query(
    "SELECT year_of_study FROM public.admission_applications WHERE application_id='application-browser-0094'",
  );
  assert.equal(browserCandidate.rows[0].year_of_study, 3, "other semester unchanged");
  const finalApi = await get();
  assert.ok(
    ["monday", "tuesday", "wednesday", "thursday", "friday"].every(
      (day) => finalApi.preferences[day] === false,
    ),
    "all unavailable is a valid explicit declaration",
  );
  assert.equal((await request(`${path}:deactivate`, leader, {}, finalApi.etag)).status, 200);
  const receiptCount = await pool.query(
    "SELECT count(*)::integer AS count FROM public.native_http_idempotency_receipts WHERE operation_id LIKE 'substitutes.%'",
  );
  assert.equal(receiptCount.rows[0].count, 5, "only five executed writes, not retries/rejections");
  const manifest = {
    revision,
    backendOrigin,
    dashboardOrigin,
    artifacts,
    departmentId,
    semesterId,
    secondSemesterId,
    noPeriodSemesterId,
    applicationId: "application-browser-0094",
    persons,
  };
  const manifestPath = join(artifacts, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const secondSemesterBefore = await pool.query(
    "SELECT row_to_json(application) AS application FROM public.admission_applications application INNER JOIN public.admission_periods period ON period.admission_period_id=application.admission_period_id WHERE period.semester_id=$1 ORDER BY application.application_id",
    [secondSemesterId],
  );
  let browserEvidence: Record<string, unknown> | null = null;

  if (process.argv.includes("--browser")) {
    run(
      "bun",
      ["apps/dashboard/e2e/run-real-native-substitute-pool.mjs"],
      {
        ...environment,
        SUBSTITUTE_JOURNEY_MANIFEST: manifestPath,
      },
      300_000,
    );
    browserEvidence = JSON.parse(await readFile(join(artifacts, "browser-evidence.json"), "utf8"));
    assert.equal(browserEvidence?.passed, true);
    assert.equal(browserEvidence?.revision, revision);
    const browserRows = await pool.query(
      `SELECT application.application_id AS "applicationId", application.year_of_study AS "yearOfStudy", preferences.active,
      jsonb_build_object('monday',monday,'tuesday',tuesday,'wednesday',wednesday,'thursday',thursday,'friday',friday,'language',language) AS preferences
      FROM public.admission_applications application INNER JOIN public.admission_substitute_preferences preferences ON preferences.application_id=application.application_id WHERE application.application_id=$1`,
      [manifest.applicationId],
    );
    assert.deepEqual(
      browserRows.rows,
      [browserEvidence?.finalExpected],
      "browser final expectation independently observed in PostgreSQL",
    );
    const secondSemesterAfter = await pool.query(
      "SELECT row_to_json(application) AS application FROM public.admission_applications application INNER JOIN public.admission_periods period ON period.admission_period_id=application.admission_period_id WHERE period.semester_id=$1 ORDER BY application.application_id",
      [secondSemesterId],
    );
    assert.deepEqual(
      secondSemesterAfter.rows,
      secondSemesterBefore.rows,
      "browser edits do not change another semester",
    );
  }
  evidence = {
    revision,
    runtime: {
      bun: process.versions.bun,
      postgres: (await pool.query("SELECT version() AS version")).rows[0].version,
    },
    apiPassed: true,
    browserEvidence,
    apiGates: [
      "canonical identity/scope",
      "real SDK session/list/profile/substitute response decoding",
      "all memberships and active global administrator",
      "wrong-department pool and forged item scope denied",
      "required conditional version header",
      "immutable submission replay after canonical year edit",
      "negative application revision rejected",
      "recruitment history retained after deactivation",
      "explicit preferences and invalid inputs",
      "member candidate privacy",
      "wrong/inactive/anonymous authority",
      "exact replay and changed-body conflict",
      "fresh stale edit",
      "generated SDK preserves precondition failure on unchanged rejected retry",
      "concurrent activation and edits",
      "deactivation preserves preferences",
      "revoked authority replay",
      "empty no-period scope",
      "other semester unchanged",
      "five executed receipts",
      "explicit all-unavailable weekdays accepted",
    ],
    receiptCount: receiptCount.rows[0].count,
    scope: "owned loopback synthetic runtime; no production/provider effects",
  };
} catch (error) {
  process.stderr.write(outputs.join("").slice(-12000));
  throw error;
} finally {
  if (pool) await pool.end();
  for (const child of children.reverse()) await stopPreviewScenarioBackend(child);
  await rm(join(artifacts, "postgres"), { recursive: true, force: true });
  await rm(join(artifacts, "manifest.json"), { force: true });
  if (evidence) {
    await writeFile(
      join(artifacts, "evidence.json"),
      JSON.stringify(
        {
          ...evidence,
          cleanup: "owned processes exited; disposable PostgreSQL and credential manifest removed",
        },
        null,
        2,
      ),
    );
    process.stdout.write(`${artifacts}/evidence.json\n`);
  }
}
