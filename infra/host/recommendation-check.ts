/**0101: previous-schema history -> actual migration -> production browser/API/PostgreSQL. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { stopPreviewScenarioBackend } from "./preview-scenario.js";
const root = new URL("../../", import.meta.url).pathname;
const dbRequire = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const uiRequire = createRequire(new URL("../../apps/dashboard/package.json", import.meta.url));
const { Pool } = dbRequire("pg");
const { chromium } = uiRequire("@playwright/test");
const AxeBuilder = uiRequire("@axe-core/playwright").default;
const run = (cmd: string, args: string[], env = process.env, cwd = root) =>
  execFileSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180000,
  });
assert.equal(run("git", ["status", "--porcelain"]).trim(), "");
const revision = run("git", ["rev-parse", "HEAD"]).trim();
const artifacts = await mkdtemp(join(tmpdir(), "vektor-recommendation-0101-"));
const logs: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
const start = (cmd: string, args: string[], env = process.env, cwd = root) => {
  const c = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  c.stdout?.on("data", (v) => logs.push(String(v)));
  c.stderr?.on("data", (v) => logs.push(String(v)));
  return c;
};
const port = async (preferred = 0) => {
  const s = createServer();
  await new Promise<void>((yes, no) => {
    s.once("error", no);
    s.listen(preferred, "127.0.0.1", yes);
  });
  const a = s.address();
  assert.ok(a && typeof a !== "string");
  await new Promise<void>((yes) => s.close(() => yes()));
  return a.port;
};
const ready = async (test: () => Promise<boolean>) => {
  for (let i = 0; i < 150; i++) {
    try {
      if (await test()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Readiness failed");
};
let pool: any, browser: any, page: any, heldIdentityClient: any;
const gates: string[] = [];
const recordGate = (...observations: string[]) => {
  gates.push(...observations);
  console.log(JSON.stringify({ observed: observations }));
};
const secrets: string[] = [];
const assertNoRecommendation = (value: unknown): void => {
  if (Array.isArray(value)) for (const item of value) assertNoRecommendation(item);
  else if (typeof value === "object" && value !== null)
    for (const [key, item] of Object.entries(value)) {
      assert.notEqual(key, "recommendation");
      assertNoRecommendation(item);
    }
};

try {
  const pgPort = await port(),
    apiPort = await port(),
    uiPort = await port(5174);
  const pgDir = join(artifacts, "postgres");
  run("initdb", ["-D", pgDir, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"]);
  start("postgres", ["-D", pgDir, "-p", String(pgPort), "-h", "127.0.0.1", "-k", artifacts]);
  const pg = `postgres://postgres@127.0.0.1:${pgPort}/postgres`,
    api = `http://127.0.0.1:${apiPort}`,
    ui = `http://127.0.0.1:${uiPort}`;
  pool = new Pool({ connectionString: pg });
  await ready(async () => {
    await pool.query("SELECT 1");
    return true;
  });
  const env = {
    ...process.env,
    JOURNEY_SEED_PG_URL: pg,
    BACKEND_PG_URL: pg,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(apiPort),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([ui]),
    OAUTH_CANONICAL_ORIGIN: api,
    OAUTH_DASHBOARD_ORIGIN: ui,
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    API_URL: api,
    VITE_API_URL: api,
    DASHBOARD_MOUNT: "/",
    HOST: "127.0.0.1",
    PORT: String(uiPort),
    NODE_ENV: "production",
  };
  secrets.push(env.BETTER_AUTH_SECRET);
  run("bun", ["packages/database/runtime/recommendation-preupgrade-fixture.ts"], env);
  const historicalBefore = (
    await pool.query(
      `SELECT to_jsonb(c) value FROM public.recruitment_interview_conducts c WHERE interview_id='interview-recommendation-history'`,
    )
  ).rows[0].value;
  run("bun", ["apps/dashboard/e2e/native-conduct-journey-seed.mjs"], env);
  const historicalAfter = (
    await pool.query(
      `SELECT to_jsonb(c)-'recommendation' value,recommendation FROM public.recruitment_interview_conducts c WHERE interview_id='interview-recommendation-history'`,
    )
  ).rows[0];
  assert.deepEqual(historicalAfter.value, historicalBefore);
  assert.equal(historicalAfter.recommendation, null);
  recordGate(
    "immutable historical row survived actual0037 upgrade without invented recommendation",
  );
  const effectSnapshot = async () => {
    const tables = (
      await pool.query(
        `SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','auth') AND (tablename LIKE '%outbox%' OR tablename LIKE '%effect%') ORDER BY schemaname,tablename`,
      )
    ).rows;
    return Promise.all(
      tables.map(async ({ schemaname, tablename }: any) => ({
        table: `${schemaname}.${tablename}`,
        rows: (
          await pool.query(
            `SELECT to_jsonb(t) value FROM "${schemaname}"."${tablename}" t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      })),
    );
  };
  const effectsBefore = await effectSnapshot();
  const link = async (suffix: string, personId: string, sql = pool) => {
    const invitation = `identity-recommendation-${suffix}`;
    await sql.query(
      `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+interval '1 day','Claimed','journey-conduct-leader-0063',CURRENT_TIMESTAMP)`,
      [
        invitation,
        `application-recommendation-${suffix}`,
        `applicant-recommendation-${suffix}`,
        createHash("sha256").update(invitation).digest("hex"),
      ],
    );
    await sql.query(
      `INSERT INTO public.applicant_account_links VALUES($1,$2,CURRENT_TIMESTAMP,$3)`,
      [`applicant-recommendation-${suffix}`, personId, invitation],
    );
  };
  await pool.query(
    `INSERT INTO public.person_profiles(person_id,first_name,last_name,revision) VALUES('recommendation-other-0101','Other','Interviewer',0)`,
  );
  await link("self", "journey-conduct-leader-0063");
  await link("maybe", "recommendation-other-0101");

  const invitationCapability = randomBytes(32).toString("base64url");
  secrets.push(invitationCapability);
  await pool.query(
    `UPDATE public.recruitment_invitations SET capability_sha256=$1 WHERE invitation_id='invitation-recommendation-maybe'`,
    [createHash("sha256").update(invitationCapability).digest("hex")],
  );

  start("bun", ["apps/backend/src/main.ts"], env);
  await ready(async () => (await fetch(`${api}/health`)).ok);
  run("bun", ["run", "build"], env, join(root, "packages/sdk"));
  run("bun", ["run", "build"], env, join(root, "apps/dashboard"));
  start("bun", ["server.mjs"], env, join(root, "apps/dashboard"));
  await ready(async () => (await fetch(`${ui}/login`)).ok);
  const password = "journey-conduct-secret-0123456789",
    email = "lina.conduct@example.invalid";
  secrets.push(password, email);
  const credentialCheck = await fetch(`${api}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: ui, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!credentialCheck.ok) {
    const failure = await credentialCheck.json();
    throw new Error(`Native sign-in failed: ${credentialCheck.status} ${JSON.stringify(failure)}`);
  }
  await credentialCheck.body?.cancel();
  recordGate("seeded native credentials accepted by real identity engine");
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/etc/profiles/per-user/nori/bin/chromium",
  });
  const context = await browser.newContext();
  const errors: string[] = [];
  context.on("page", (p: any) => p.on("pageerror", () => errors.push("pageerror")));
  page = await context.newPage();
  await page.goto(`${ui}/login`);
  await page.getByLabel("E-post", { exact: true }).fill(email);
  await page.getByLabel("Passord", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await page.waitForURL(/\/dashboard\/?$/);
  await page.goto(`${ui}/dashboard/intervjuer`);
  const cookies = await context.cookies();
  const cookie = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  secrets.push(...cookies.map((c: any) => c.value));
  const get = (id: string) =>
    fetch(`${api}/api/recruitment/interviews/${id}`, { headers: { cookie, origin: ui } });
  const post = (id: string, body: unknown, key: string, etag: string) =>
    fetch(`${api}/api/recruitment/interviews/${id}:finalize`, {
      method: "POST",
      headers: {
        cookie,
        origin: ui,
        "content-type": "application/json",
        "idempotency-key": key,
        "if-match": etag,
      },
      body: JSON.stringify(body),
    });
  const open = async (p: any, name: string) => {
    await p
      .getByRole("article")
      .filter({ hasText: name })
      .getByRole("button", { name: "Åpne intervju" })
      .click();
    await p.getByRole("heading", { name: `Intervju med ${name}` }).waitFor();
  };
  const fill = async (p: any) => {
    await p
      .locator("#question-interview-schema-native-conduct-0063-q0")
      .fill("Jeg vil forklare matematikk tydelig.");
    await p.locator("#question-interview-schema-native-conduct-0063-q1-1").check();
    await p.locator("#question-interview-schema-native-conduct-0063-q2-0").check();
    await p.locator("#question-interview-schema-native-conduct-0063-q3-0").check();
    for (const axis of ["explanatoryPower", "roleModel", "suitability"])
      await p.locator(`#score-${axis}`).selectOption("8");
  };
  await open(page, "Sofie Gjennomfører");
  await fill(page);
  assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "");
  await page.locator("#fs-conduct").screenshot({ path: join(artifacts, "editable-desktop.png") });
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.locator("#fs-conduct").screenshot({ path: join(artifacts, "editable-mobile.png") });
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Fullfør intervju", exact: true }).click();
  await page
    .getByText("Svar på alle spørsmål, velg alle tre scorer og en anbefaling.", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#score-suitability").inputValue(), "8");
  const staleContext = await browser.newContext({ storageState: await context.storageState() });
  const stale = await staleContext.newPage();
  stale.on("pageerror", () => errors.push("stale-pageerror"));
  await stale.goto(`${ui}/dashboard/intervjuer`);
  await open(stale, "Sofie Gjennomfører");
  await fill(stale);
  await stale.locator("#interviewer-recommendation").selectOption("Kanskje");
  await page.locator("#interviewer-recommendation").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "Ja");
  await page.getByRole("button", { name: "Fullfør intervju", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: join(artifacts, "confirmation.png") });
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Fullfør intervju", exact: true })
    .press("Enter");
  await page.getByText("Intervjuet er fullført.", { exact: true }).waitFor();
  await page.reload();
  await open(page, "Sofie Gjennomfører");
  assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "Ja");
  await page
    .locator("#fs-conduct")
    .screenshot({ path: join(artifacts, "recommendation-desktop.png") });
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page
    .locator("#fs-conduct")
    .screenshot({ path: join(artifacts, "recommendation-mobile.png") });
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
  await page.setViewportSize({ width: 1280, height: 900 });
  await stale.getByRole("button", { name: "Fullfør intervju", exact: true }).click();
  await stale
    .getByRole("dialog")
    .getByRole("button", { name: "Fullfør intervju", exact: true })
    .press("Enter");
  await stale
    .getByText(
      "Intervjuet er endret. Utkastet er beholdt; åpne intervjuet på nytt for å hente gjeldende versjon.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await stale.locator("#interviewer-recommendation").inputValue(), "Kanskje");
  await stale.locator("#fs-conduct").screenshot({ path: join(artifacts, "stale-draft.png") });
  assert.deepEqual((await new AxeBuilder({ page: stale }).analyze()).violations, []);
  await stale.close();
  await staleContext.close();
  recordGate(
    "ordinary assigned member: required choice, keyboard finalization, reload and real stale-conflict draft retention",
  );
  const answers = [
    { questionId: "interview-schema-native-conduct-0063-q0", answer: "Et tydelig svar" },
    { questionId: "interview-schema-native-conduct-0063-q1", answer: "Teknologi" },
    { questionId: "interview-schema-native-conduct-0063-q2", answer: "Praksis" },
    { questionId: "interview-schema-native-conduct-0063-q3", answer: ["Samarbeid"] },
  ];
  const payload = { answers, score: { explanatoryPower: 7, roleModel: 8, suitability: 9 } };
  const id = "interview-recommendation-maybe",
    initial = await get(id);
  assert.equal(initial.status, 200);
  const etag = initial.headers.get("etag")!;
  const lifecycleSnapshot = async () =>
    JSON.stringify(
      (
        await pool.query(
          `SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.interview_id) FROM public.recruitment_interview_conducts c) conducts,(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.command_id) FROM public.recruitment_interview_lifecycle_command_receipts r) receipts,(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.command_id) FROM public.recruitment_interview_lifecycle_audit a) audit,(SELECT jsonb_agg(to_jsonb(h) ORDER BY to_jsonb(h)::text) FROM public.native_http_idempotency_receipts h) native_receipts`,
        )
      ).rows[0],
    );
  const before = await lifecycleSnapshot();
  for (const [i, value] of [undefined, null, "invalid", 9].entries()) {
    const body = value === undefined ? payload : { ...payload, recommendation: value };
    assert.equal((await post(id, body, `invalid-recommendation-0101-${i}`, etag)).status, 422);
  }
  assert.equal(await lifecycleSnapshot(), before);
  const first = await post(
    id,
    { ...payload, recommendation: "Kanskje" },
    "recommendation-maybe-0101",
    etag,
  );
  assert.equal(first.status, 200);
  const bytes = await first.text();
  assert.equal(
    await (
      await post(id, { ...payload, recommendation: "Kanskje" }, "recommendation-maybe-0101", etag)
    ).text(),
    bytes,
  );
  assert.equal(
    (await post(id, { ...payload, recommendation: "Nei" }, "recommendation-maybe-0101", etag))
      .status,
    409,
  );
  const no = await get("interview-recommendation-no");
  const race = await Promise.all([
    post(
      "interview-recommendation-no",
      { ...payload, recommendation: "Nei" },
      "recommendation-no-a-0101",
      no.headers.get("etag")!,
    ),
    post(
      "interview-recommendation-no",
      { ...payload, recommendation: "Ja" },
      "recommendation-no-b-0101",
      no.headers.get("etag")!,
    ),
  ]);
  assert.ok(race.filter((r) => r.status === 200).length === 1);
  assert.ok(race.every((r) => [200, 409, 412].includes(r.status)));
  const saved = (await (await get("interview-recommendation-no")).json()).recommendation;
  assert.equal(saved, race[0].status === 200 ? "Nei" : "Ja");
  // Ensure Nei has an independent exact round trip even when Ja won the concurrent race.
  if (saved !== "Nei") {
    const b = await get("interview-native-conduct-b-0063");
    assert.equal(
      (
        await post(
          "interview-native-conduct-b-0063",
          { ...payload, recommendation: "Nei" },
          "recommendation-no-0101",
          b.headers.get("etag")!,
        )
      ).status,
      200,
    );
    assert.equal(
      (await (await get("interview-native-conduct-b-0063")).json()).recommendation,
      "Nei",
    );
  }
  assert.equal((await (await get(id)).json()).recommendation, "Kanskje");
  recordGate(
    "missing/null/unknown/numeric rejected without effects; all choices roundtrip; exact replay and conflicting/concurrent writes fenced",
  );
  await pool.query(
    `UPDATE public.organization_memberships SET is_suspended=true WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  assert.equal((await get(id)).status, 403);
  assert.equal(
    (await post(id, { ...payload, recommendation: "Kanskje" }, "recommendation-maybe-0101", etag))
      .status,
    403,
  );
  await pool.query(
    `UPDATE public.organization_memberships SET is_suspended=false WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  recordGate("suspended authority denies reads and stored receipt replay");
  const authorizationBefore = await lifecycleSnapshot();

  // Change current source authority, not authentication claims or an authorization stub.
  await pool.query(
    `UPDATE public.recruitment_interviews SET interviewer_person_id='recommendation-other-0101' WHERE interview_id=$1`,
    [id],
  );
  assert.equal((await get(id)).status, 403);
  assert.equal(
    (await post(id, { ...payload, recommendation: "Kanskje" }, "recommendation-maybe-0101", etag))
      .status,
    403,
  );
  await pool.query(
    `UPDATE public.recruitment_interviews SET interviewer_person_id='journey-conduct-leader-0063' WHERE interview_id=$1`,
    [id],
  );
  await pool.query(
    `UPDATE public.organization_memberships SET end_at=CURRENT_TIMESTAMP - interval '1 day' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  assert.equal((await get(id)).status, 403);
  assert.equal(
    (await post(id, { ...payload, recommendation: "Kanskje" }, "recommendation-maybe-0101", etag))
      .status,
    403,
  );
  await pool.query(
    `UPDATE public.organization_memberships SET end_at=NULL WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  await pool.query(
    `INSERT INTO public.organization_departments SELECT (jsonb_populate_record(NULL::public.organization_departments,to_jsonb(d)||'{"department_id":"department-other-recommendation-0101"}'::jsonb)).* FROM public.organization_departments d WHERE department_id='department-native-conduct-0063'`,
  );
  await pool.query(
    `INSERT INTO public.organization_teams SELECT (jsonb_populate_record(NULL::public.organization_teams,to_jsonb(t)||'{"team_id":"team-other-recommendation-0101","department_id":"department-other-recommendation-0101"}'::jsonb)).* FROM public.organization_teams t WHERE team_id='team-native-conduct-0063'`,
  );
  await pool.query(
    `UPDATE public.organization_memberships SET team_id='team-other-recommendation-0101' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  assert.equal((await get(id)).status, 403);
  assert.equal(
    (await post(id, { ...payload, recommendation: "Kanskje" }, "recommendation-maybe-0101", etag))
      .status,
    403,
  );
  await pool.query(
    `UPDATE public.organization_memberships SET team_id='team-native-conduct-0063' WHERE membership_id='membership-native-conduct-leader-0063'`,
  );
  assert.equal(await lifecycleSnapshot(), authorizationBefore);
  const applicantResponse = await fetch(`${api}/api/recruitment/invitation-response`, {
    headers: { "x-recruitment-invitation-capability": invitationCapability, origin: ui },
  });
  assert.equal(applicantResponse.status, 200);
  const applicantObservation = await applicantResponse.text();
  assertNoRecommendation(JSON.parse(applicantObservation));
  assert.ok(!applicantObservation.includes("Kanskje"));
  const applicationProjection = await fetch(
    `${api}/api/applications/application-recommendation-maybe`,
  );
  assert.equal(applicationProjection.status, 200);
  const applicationBody = await applicationProjection.text();
  assertNoRecommendation(JSON.parse(applicationBody));
  assert.ok(!applicationBody.includes("Kanskje"));
  recordGate(
    "wrong department denied; actual applicant capability projection excludes recommendation",
  );

  recordGate(
    "removed assignment and ended membership deny read/write/replay without lifecycle writes",
  );

  const lifecycleBeforeSelf = await lifecycleSnapshot();
  assert.equal((await get("interview-recommendation-self")).status, 403);
  assert.equal(
    (
      await post(
        "interview-recommendation-self",
        { ...payload, recommendation: "Ja" },
        "known-self-0101",
        etag,
      )
    ).status,
    403,
  );
  const selfCancel = await fetch(
    `${api}/api/recruitment/interviews/interview-recommendation-self:cancel`,
    {
      method: "POST",
      headers: {
        cookie,
        origin: ui,
        "content-type": "application/json",
        "if-match": etag,
        "idempotency-key": "self-cancel-0101",
      },
      body: "{}",
    },
  );
  assert.equal(selfCancel.status, 403);
  assert.deepEqual(await effectSnapshot(), effectsBefore);
  // This separate actual onboarding action observes its applicant-facing projection.
  const onboardingToken = `onboard_${randomBytes(32).toString("hex")}`;
  secrets.push(onboardingToken);
  await pool.query(
    `INSERT INTO public.applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) VALUES('identity-recommendation-no','application-recommendation-no','applicant-recommendation-no',$1,CURRENT_TIMESTAMP+interval '1 day','Open','journey-conduct-leader-0063',CURRENT_TIMESTAMP)`,
    [createHash("sha256").update(onboardingToken).digest("hex")],
  );
  await pool.query(
    `INSERT INTO public.applicant_account_delivery(invitation_id,state,secret,recipient) VALUES('identity-recommendation-no','Pending',$1,'no@example.invalid')`,
    [onboardingToken],
  );
  const onboardingProjection = await fetch(`${api}/api/onboarding/claim`, {
    method: "POST",
    headers: { cookie, origin: ui, "content-type": "application/json" },
    body: JSON.stringify({ mode: "ExistingAccount", token: onboardingToken }),
  });
  assert.equal(onboardingProjection.status, 200);
  assert.deepEqual(await onboardingProjection.json(), {
    state: "Claimed",
    departmentId: "department-native-conduct-0063",
  });
  const effectsAfterOnboarding = await effectSnapshot();
  recordGate(
    "actual application confirmation and onboarding claim projections exclude recommendation; recommendation produced no effect rows",
  );

  assert.equal((await get("interview-recommendation-no")).status, 403);
  const winner = race.findIndex((r) => r.status === 200);
  assert.equal(
    (
      await post(
        "interview-recommendation-no",
        { ...payload, recommendation: winner === 0 ? "Nei" : "Ja" },
        winner === 0 ? "recommendation-no-a-0101" : "recommendation-no-b-0101",
        no.headers.get("etag")!,
      )
    ).status,
    403,
  );
  run("bun", ["packages/database/runtime/recommendation-domain-replay.ts"], env);
  const raceRead = await get("interview-recommendation-link-race");
  assert.equal(raceRead.status, 200);
  const locker = await pool.connect();
  heldIdentityClient = locker;
  await locker.query("BEGIN");
  await locker.query(
    `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id='applicant-recommendation-link-race' FOR UPDATE`,
  );
  const lockerPid = (await locker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  const waiting = post(
    "interview-recommendation-link-race",
    { ...payload, recommendation: "Ja" },
    "identity-race-0101",
    raceRead.headers.get("etag")!,
  );
  await ready(
    async () =>
      (
        await pool.query(
          `SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
          [lockerPid],
        )
      ).rows[0].n > 0,
  );
  await link("link-race", "journey-conduct-leader-0063", locker);
  await locker.query("COMMIT");
  locker.release();
  heldIdentityClient = undefined;
  const staleIdentity = await waiting;
  assert.equal(staleIdentity.status, 409);
  assert.equal((await staleIdentity.json()).code, "transaction.conflict");
  assert.equal(
    (
      await post(
        "interview-recommendation-link-race",
        { ...payload, recommendation: "Ja" },
        "identity-race-0101",
        raceRead.headers.get("etag")!,
      )
    ).status,
    403,
  );
  assert.equal((await get("interview-recommendation-link-race")).status, 403);

  const readLocker = await pool.connect();
  heldIdentityClient = readLocker;
  await readLocker.query("BEGIN");
  await readLocker.query(
    `SELECT applicant_id FROM public.admission_applicants WHERE applicant_id='applicant-recommendation-read-race' FOR UPDATE`,
  );
  const readLockerPid = (await readLocker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  const waitingRead = get("interview-recommendation-read-race");
  await ready(
    async () =>
      (
        await pool.query(
          `SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`,
          [readLockerPid],
        )
      ).rows[0].n > 0,
  );
  await link("read-race", "journey-conduct-leader-0063", readLocker);
  await readLocker.query("COMMIT");
  readLocker.release();
  heldIdentityClient = undefined;
  assert.equal((await waitingRead).status, 403);
  assert.equal(await lifecycleSnapshot(), lifecycleBeforeSelf);
  recordGate(
    "known self denied before read/finalize/cancel and both receipt layers; different Person allowed; real waiting serializable snapshot fails409 then self-denial",
  );
  let immutable = false;
  try {
    await pool.query(
      `UPDATE public.recruitment_interview_conducts SET recommendation='Ja' WHERE interview_id='interview-recommendation-history'`,
    );
  } catch {
    immutable = true;
  }
  assert.ok(immutable);
  for (const value of [null, "wrong", ""]) {
    let rejected = false;
    try {
      await pool.query(
        `INSERT INTO public.recruitment_interview_conducts(interview_id,answers,explanatory_power,role_model,suitability,finalized_by_person_id,finalized_at,interview_revision,recommendation) VALUES('invalid-direct-0101','[]',1,1,1,'journey-conduct-leader-0063',CURRENT_TIMESTAMP,1,$1)`,
        [value],
      );
    } catch (e) {
      rejected = (e as { code?: string }).code === "23514";
    }
    assert.ok(rejected);
  }
  await page.reload();
  await open(page, "history Recommendation");
  assert.equal(await page.locator("#interviewer-recommendation").inputValue(), "");
  assert.equal(
    await page.locator("#interviewer-recommendation option:checked").textContent(),
    "Ikke registrert",
  );
  await page.locator("#fs-conduct").screenshot({ path: join(artifacts, "historical-desktop.png") });
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#fs-conduct").screenshot({ path: join(artifacts, "historical-mobile.png") });
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
  const rows = (
    await pool.query(
      `SELECT interview_id,recommendation,answers,explanatory_power,role_model,suitability FROM public.recruitment_interview_conducts ORDER BY interview_id`,
    )
  ).rows;
  assert.equal(
    rows.find((r: any) => r.interview_id === "interview-native-conduct-a-0063").recommendation,
    "Ja",
  );
  assert.equal(
    rows.find((r: any) => r.interview_id === "interview-recommendation-history").recommendation,
    null,
  );
  const maybeRow = rows.find((r: any) => r.interview_id === id);
  assert.deepEqual(maybeRow.answers, answers);
  assert.equal(maybeRow.explanatory_power, 7);
  assert.equal(maybeRow.role_model, 8);
  assert.equal(maybeRow.suitability, 9);
  const lifecycle = (
    await pool.query(
      `SELECT c.interview_id,c.recommendation,a.kind,a.resulting_revision,r.command_id FROM public.recruitment_interview_conducts c JOIN public.recruitment_interview_lifecycle_audit a USING(interview_id) JOIN public.recruitment_interview_lifecycle_command_receipts r ON r.command_id=a.command_id ORDER BY c.interview_id`,
    )
  ).rows;
  assert.equal(lifecycle.length, rows.length - 1);
  assert.ok(lifecycle.every((r: any) => r.kind === "InterviewFinalized"));
  assert.equal(new Set(lifecycle.map((r: any) => r.interview_id)).size, lifecycle.length);
  assert.deepEqual(await effectSnapshot(), effectsAfterOnboarding);
  assert.deepEqual(errors, []);
  for (const secret of secrets) assert.ok(!JSON.stringify(logs).includes(secret));
  recordGate(
    "historical immutable not-recorded display; direct storage constraints; desktop/mobile Axe; independent public-schema SQL",
  );
  await writeFile(
    join(artifacts, "evidence.json"),
    JSON.stringify(
      {
        revision,
        gates,
        rows,
        lifecycle,
        pageErrors: errors,
        observer: "independent PostgreSQL connection",
        noNotificationEffects: true,
      },
      null,
      2,
    ),
  );
  for (const entry of await readdir(artifacts, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.endsWith(".png")) {
      const text = await readFile(join(artifacts, entry.name), "utf8");
      for (const secret of secrets)
        assert.ok(!text.includes(secret), `retained artifact ${entry.name} contains a credential`);
    }
  }
  console.log(JSON.stringify({ result: "Passed", revision, artifacts, gates }));
} catch (error) {
  let detail = error instanceof Error ? error.message : String(error);
  if (page)
    detail += ` Current page: ${await page
      .locator("body")
      .innerText()
      .catch(() => "unavailable")}`;

  for (const secret of secrets) detail = detail.replaceAll(secret, "[redacted]");
  console.error(
    JSON.stringify({
      result: "Failed",
      gates,
      detail: detail.slice(0, 2000),
      logs: logs
        .slice(-6)
        .map((line) =>
          secrets.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), line),
        ),
      artifacts,
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (heldIdentityClient) {
    await heldIdentityClient.query("ROLLBACK");
    heldIdentityClient.release();
  }
  await pool?.end();
  for (const child of children.reverse()) await stopPreviewScenarioBackend(child);
  await rm(join(artifacts, "postgres"), { recursive: true, force: true });
}
