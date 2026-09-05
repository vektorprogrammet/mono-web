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
const run = (command: string, args: string[], env = process.env) =>
  execFileSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 60_000 });
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
  const applicationId = "application-native-journey-0049",
    path = `/api/substitutes/${applicationId}`;
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
  const initial = await get();
  assert.equal(initial.active, false);
  assert.equal(initial.preferences, null);
  for (const cookie of [undefined, wrong]) {
    assert.ok([401, 403].includes((await request(path, cookie)).status));
  }
  assert.equal((await request(path, member)).status, 403, "inactive item private from member");
  const selectedPool = `/api/substitutes?departmentId=${departmentId}&semesterId=${secondSemesterId}`;
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
  assert.ok([4, 5].includes(edited.yearOfStudy));
  const deactivated = await request(`${path}:deactivate`, leader, {}, edited.etag);
  assert.equal(deactivated.status, 200);
  const inactive = await deactivated.json();
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
  const concurrent = await Promise.all([
    request(`${path}:activate`, leader, body, inactive.etag),
    request(`${path}:activate`, leader, body, inactive.etag),
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
  let browserEvidence: unknown = null;
  if (process.argv.includes("--browser")) {
    run("bun", ["apps/dashboard/e2e/run-real-native-substitute-pool.mjs"], {
      ...environment,
      SUBSTITUTE_JOURNEY_MANIFEST: manifestPath,
    });
    browserEvidence = JSON.parse(await readFile(join(artifacts, "browser-evidence.json"), "utf8"));
  }
  evidence = {
    revision,
    apiPassed: true,
    browserEvidence,
    apiGates: [
      "canonical identity/scope",
      "explicit preferences and invalid inputs",
      "member candidate privacy",
      "wrong/inactive/anonymous authority",
      "exact replay and changed-body conflict",
      "fresh stale edit",
      "concurrent activation and edits",
      "deactivation preserves preferences",
      "revoked authority replay",
      "empty no-period scope",
      "other semester unchanged",
      "five executed receipts",
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
