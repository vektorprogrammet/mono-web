/** Spec0054.2: real PostgreSQL, HTTP acknowledgement mailbox and production browser journey. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { stopPreviewScenarioBackend } from "./preview-scenario.js";
import { drainPasswordResetMail } from "../../packages/database/src/password-recovery.js";
import { makeHttpPasswordResetDelivery } from "../../apps/backend/src/password-recovery/http-delivery.js";
const root = new URL("../../", import.meta.url).pathname;
const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
const requireDashboard = createRequire(
  new URL("../../apps/dashboard/package.json", import.meta.url),
);
const { Pool } = requireDatabase("pg");
const { chromium } = requireDashboard("@playwright/test");
const logs: string[] = [];
const run = (command: string, args: string[], env = process.env, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180000,
    stdio: ["ignore", "pipe", "pipe"],
  });
assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "committed clean tree required");
const revision = run("git", ["rev-parse", "HEAD"]).trim();
const artifacts = await mkdtemp(join(tmpdir(), "vektor-recovery-0054-"));
const children: ReturnType<typeof spawn>[] = [];
const start = (command: string, args: string[], env = process.env, cwd = root) => {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
  return child;
};
const port = async (requested = 0) => {
  const s = createServer();
  await new Promise<void>((ok, no) => {
    s.once("error", no);
    s.listen(requested, "127.0.0.1", ok);
  });
  const a = s.address();
  assert.ok(a && typeof a !== "string");
  await new Promise<void>((ok) => s.close(() => ok()));
  return a.port;
};
const wait = async (test: () => Promise<boolean>) => {
  for (let i = 0; i < 150; i++) {
    try {
      if (await test()) return;
    } catch {}
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error("Readiness timeout");
};
let pool: InstanceType<typeof Pool> | undefined;
let browser: any;
let mailbox: ReturnType<typeof Bun.serve> | undefined;
const secrets: string[] = [];
const gates: string[] = [];
try {
  const pgPort = await port(),
    apiPort = await port(),
    uiPort = await port(5174);
  const pgDir = join(artifacts, "postgres");
  run("initdb", ["-D", pgDir, "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"]);
  start("postgres", [
    "-D",
    pgDir,
    "-p",
    String(pgPort),
    "-h",
    "127.0.0.1",
    "-k",
    artifacts,
    "-c",
    "log_min_error_statement=panic",
  ]);
  const pg = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
  pool = new Pool({ connectionString: pg });
  await wait(async () => {
    await pool.query("SELECT 1");
    return true;
  });
  const canonicalOrigin = `http://127.0.0.1:${apiPort}`,
    dashboardOrigin = `http://127.0.0.1:${uiPort}`;
  const env = {
    ...process.env,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(apiPort),
    BACKEND_PG_URL: pg,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
    OAUTH_CANONICAL_ORIGIN: canonicalOrigin,
    OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    JOURNEY_SEED_PG_URL: pg,
    API_URL: canonicalOrigin,
    VITE_API_URL: canonicalOrigin,
    PASSWORD_RECOVERY_ENGINE: "native",
    HOST: "127.0.0.1",
    PORT: String(uiPort),
    NODE_ENV: "production",
    DASHBOARD_MOUNT: "/dashboard/",
  };
  run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], env);
  start("bun", ["apps/backend/src/main.ts"], env);
  await wait(async () => {
    const r = await fetch(`${canonicalOrigin}/api/auth/ok`);
    return r.ok;
  });
  const email = "lina.leader@example.invalid",
    oldPassword = "journey-secret-0123456789abcdef",
    newPassword = "New-password-recovery-0123456789";
  secrets.push(email, oldPassword, newPassword);
  const post = (path: string, body: unknown, origin = dashboardOrigin) =>
    fetch(`${canonicalOrigin}/api/auth/${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });
  const login = async (password: string) => {
    const r = await post("sign-in/email", { email, password });
    assert.equal(r.status, 200);
    return r.headers.getSetCookie()[0]!.split(";")[0]!;
  };
  const cookie1 = await login(oldPassword),
    cookie2 = await login(oldPassword);
  secrets.push(cookie1, cookie2);
  const messages = new Map<string, { resetUrl: string; recipientEmail: string }>();
  let rejectMail = false;
  const mailboxToken = randomBytes(24).toString("hex");
  secrets.push(mailboxToken);
  mailbox = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${mailboxToken}`)
        return new Response(null, { status: 401 });
      if (request.method === "GET") return Response.json([...messages.values()]);
      if (rejectMail) return new Response(null, { status: 503 });
      const body = (await request.json()) as {
        effectId: string;
        resetUrl: string;
        recipientEmail: string;
      };
      messages.set(body.effectId, body);
      return Response.json({ acknowledged: true });
    },
  });
  const delivery = makeHttpPasswordResetDelivery({
    endpoint: new URL(`http://127.0.0.1:${mailbox.port}/mail`),
    token: mailboxToken,
    deliveryTimeoutMilliseconds: 2000,
    sender: "recovery@example.invalid",
  });
  const drain = () =>
    drainPasswordResetMail(
      pool,
      {
        oauth: {
          canonicalOrigin,
          dashboardOrigin,
          nativeApiResource: "urn:vektorprogrammet:native-api",
        },
      },
      delivery,
    );
  run("bun", ["run", "build"], env, join(root, "packages/sdk"));
  run("bun", ["run", "build"], env, join(root, "apps/dashboard"));
  start("bun", ["e2e/recovery-server.mjs"], env, join(root, "apps/dashboard"));
  await wait(async () => (await fetch(`${dashboardOrigin}/glemt-passord`)).ok);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("Browser runtime error"));
  await page.goto(`${dashboardOrigin}/glemt-passord`);
  await page.getByLabel("E-post", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send tilbakestillingslenke" }).click();
  await page.getByText("Hvis kontoen finnes", { exact: false }).waitFor();
  await page.goto(`${dashboardOrigin}/glemt-passord`);
  await page.getByLabel("E-post", { exact: true }).fill("unknown@example.invalid");
  await page.getByRole("button", { name: "Send tilbakestillingslenke" }).click();
  await page.getByText("Hvis kontoen finnes", { exact: false }).waitFor();
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM auth.password_reset_email_outbox")).rows[0].n,
    1,
  );
  assert.equal(
    await drainPasswordResetMail(
      pool,
      {
        oauth: {
          canonicalOrigin,
          dashboardOrigin,
          nativeApiResource: "urn:vektorprogrammet:native-api",
        },
      },
      makeHttpPasswordResetDelivery(undefined),
    ),
    "Failed",
  );
  rejectMail = true;
  assert.equal(await drain(), "Failed");
  rejectMail = false;
  assert.equal(await drain(), "Delivered");
  gates.push(
    "known/unknown concealment, durable acceptance, missing authority, HTTP503 retry and ACK",
  );
  const received = (await (
    await fetch(`http://127.0.0.1:${mailbox.port}/mail`, {
      headers: { authorization: `Bearer ${mailboxToken}` },
    })
  ).json()) as { resetUrl: string }[];
  const resetUrl = received[0]!.resetUrl;
  const token = new URL(resetUrl).pathname.split("/").at(-1)!;
  secrets.push(token, resetUrl);
  await page.goto(resetUrl);
  assert.equal(new URL(page.url()).pathname, "/tilbakestill-passord");
  await page.getByLabel("Nytt passord", { exact: true }).fill(newPassword);
  await page.getByLabel("Gjenta passord", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "Lagre passord" }).click();
  await page.waitForURL("**/login?reset=true");
  for (const cookie of [cookie1, cookie2]) {
    const r = await fetch(`${canonicalOrigin}/api/native/system/session`, {
      headers: { cookie, origin: dashboardOrigin },
    });
    assert.equal(r.status, 401);
  }
  assert.equal((await post("sign-in/email", { email, password: oldPassword })).status, 401);
  await login(newPassword);
  assert.equal((await post("reset-password", { token, newPassword: oldPassword })).status, 400);
  gates.push(
    "browser callback/reset, both old sessions denied, old password denied, new login, reused token denied",
  );
  const requestReset = () =>
    post("request-password-reset", {
      email,
      redirectTo: `${dashboardOrigin}/tilbakestill-passord`,
    });
  assert.equal((await requestReset()).status, 200);
  await pool.query(
    `UPDATE auth.verification SET "expiresAt"=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE identifier LIKE 'reset-password:%'`,
  );
  assert.equal(await drain(), "Quarantined");
  await page.goto(
    `${canonicalOrigin}/api/auth/reset-password/expired-or-malformed?callbackURL=${encodeURIComponent(`${dashboardOrigin}/tilbakestill-passord`)}`,
  );
  await page.getByText("Lenken er ugyldig eller utløpt.").waitFor();
  assert.equal(
    (await post("request-password-reset", { email, redirectTo: `${dashboardOrigin}/login` }))
      .status,
    403,
  );
  assert.equal(
    (
      await post(
        "request-password-reset",
        { email, redirectTo: `${dashboardOrigin}/tilbakestill-passord` },
        "https://evil.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(
        `${canonicalOrigin}/api/auth/reset-password/malformed?callbackURL=${encodeURIComponent(`${dashboardOrigin}/login`)}`,
        { redirect: "manual" },
      )
    ).status,
    403,
  );
  gates.push("expired quarantine, invalid callback page, origin and callback path denial");
  await pool.query(
    `CREATE FUNCTION auth.reject_recovery_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic enqueue failure'; END $$; CREATE TRIGGER reject_recovery_enqueue BEFORE INSERT ON auth.password_reset_email_outbox FOR EACH ROW EXECUTE FUNCTION auth.reject_recovery_enqueue()`,
  );
  assert.equal((await requestReset()).status, 503);
  await pool.query(
    `DROP TRIGGER reject_recovery_enqueue ON auth.password_reset_email_outbox; DROP FUNCTION auth.reject_recovery_enqueue()`,
  );
  gates.push("enqueue failure replaces swallowed engine success with503");
  await requestReset();
  await pool.query(
    `UPDATE auth.password_reset_email_outbox SET status='Processing',claim_id=gen_random_uuid(),claimed_at=CURRENT_TIMESTAMP-INTERVAL '2 minutes' WHERE status='Pending'`,
  );
  assert.equal(await drain(), "Delivered");
  await requestReset();
  const simultaneous = await Promise.all([drain(), drain()]);
  assert.deepEqual(simultaneous.sort(), ["Delivered", "Empty"]);
  gates.push("stale recovery and concurrent SKIP LOCKED claims");
  const audits = (
    await pool.query(
      "SELECT event_kind,subject_person_id,details,request_correlation FROM auth.identity_security_audit ORDER BY occurred_at",
    )
  ).rows;
  const outbox = (await pool.query("SELECT * FROM auth.password_reset_email_outbox")).rows;
  const safe = JSON.stringify({ audits, outbox, logs });
  for (const secret of secrets) assert.ok(!safe.includes(secret), "sensitive value leaked");
  assert.ok(audits.some((r: any) => r.event_kind === "password-reset-success"));
  assert.deepEqual(errors, []);
  await page.goto(`${dashboardOrigin}/tilbakestill-passord`);
  await page.screenshot({ path: join(artifacts, "invalid-link.png") });
  await writeFile(
    join(artifacts, "evidence.json"),
    JSON.stringify(
      {
        revision,
        gates,
        audits: audits.map((r: any) => ({
          eventKind: r.event_kind,
          outcome: r.details.outcomeCode,
        })),
        outbox: outbox.map((r: any) => ({ status: r.status, attempts: r.attempts })),
        browserErrors: errors,
        transport: "synthetic authenticated loopback HTTP mailbox; not production email",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ result: "Passed", artifacts, revision, gates }));
} finally {
  await browser?.close();
  await mailbox?.stop(true);
  await pool?.end();
  for (const child of children.reverse()) await stopPreviewScenarioBackend(child);
  await rm(join(artifacts, "postgres"), { recursive: true, force: true });
}
