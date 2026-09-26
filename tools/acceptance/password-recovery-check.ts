import { type Server } from "bun";
/** Spec0054.2: real PostgreSQL, HTTP acknowledgement mailbox and production browser journey. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Predicate, Console, Effect, Layer, Schema } from "effect";
import { MailDeliveryRequest, Mail } from "@vektorprogrammet/domain/mail";
import { stopOwnedProcess } from "./owned-process.js";
import { type DisposablePostgres, startDisposablePostgres } from "../postgres/index.ts";
import { drainPasswordResetMail } from "../../packages/database/src/password-recovery.js";
import { HttpMailLive } from "../../apps/backend/src/mail/http.js";

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
  assert.ok(a && !Predicate.isString(a));
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

let postgres: DisposablePostgres | undefined;

let pool: InstanceType<typeof Pool> | undefined;

let browser: any;

let page: any;

let mailbox: Server<undefined> | undefined;

const secrets: string[] = [];

const gates: string[] = [];

const submissions: { tokenPresent: boolean; queryAbsent: boolean }[] = [];

try {
  const apiPort = await port(),
    uiPort = await port(5174);

  postgres = await startDisposablePostgres();
  const pg = postgres.url;
  pool = new Pool({ connectionString: pg });

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
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
    JOURNEY_SEED_PG_URL: pg,
    API_URL: canonicalOrigin,
    VITE_API_URL: canonicalOrigin,
    PASSWORD_RECOVERY_ENGINE: "native",
    HOST: "127.0.0.1",
    PORT: String(uiPort),
    NODE_ENV: "production",
    DASHBOARD_MOUNT: "/",
  };

  run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], env);
  start("bun", ["apps/backend/src/main.ts"], env);
  await wait(async () => {
    const r = await fetch(`${canonicalOrigin}/health`);

    return r.ok;
  });

  const email = "lina.leader@example.invalid",
    oldPassword = "journey-secret-0123456789abcdef",
    newPassword = "New-password-recovery-0123456789";

  secrets.push(email, oldPassword, newPassword);

  const post = async (
    path: string,
    body: Schema.Json,
    origin = dashboardOrigin,
  ): Promise<Response> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`${canonicalOrigin}/api/auth/${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
      });

      if (response.status !== 429) return response;
      const retry = Number(response.headers.get("x-retry-after"));
      assert.ok(Number.isFinite(retry) && retry >= 0 && retry <= 60, "bounded engine retry window");
      gates.push("real credential rate limit observed; waited retry window");
      await response.body?.cancel();
      await new Promise((ok) => setTimeout(ok, retry * 1000 + 100));
    }

    throw new Error("Credential rate limit did not clear");
  };

  const login = async (password: string) => {
    const r = await post("sign-in/email", { email, password });
    assert.equal(r.status, 200);

    return r.headers.getSetCookie()[0]!.split(";")[0]!;
  };

  const cookie1 = await login(oldPassword),
    cookie2 = await login(oldPassword);

  secrets.push(cookie1, cookie2);
  const messages = new Map<string, { text: string; recipient: string }>();
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

      const body = Schema.decodeUnknownSync(MailDeliveryRequest)(await request.json());

      messages.set(body.deliveryId, body);

      return Response.json({ acknowledged: true });
    },
  });

  const delivery = HttpMailLive({
    endpoint: new URL(`http://127.0.0.1:${mailbox.port}/mail`),
    token: mailboxToken,
    deliveryTimeoutMilliseconds: 2000,
  });

  const drainWith = (provider: Layer.Layer<Mail>) =>
    Effect.runPromise(
      Mail.use((mail) =>
        drainPasswordResetMail(pool,
        {
          oauth: {
            canonicalOrigin,
            dashboardOrigin,
            nativeApiResource: "urn:vektorprogrammet:native-api",
          },
        },
        mail,
        "recovery@example.invalid",),
      ).pipe(Effect.provide(provider)),
    );

  const drain = () => drainWith(delivery);

  run("bun", ["run", "build"], env, join(root, "packages/sdk"));
  run("bun", ["run", "build"], env, join(root, "apps/dashboard"));
  start("bun", ["server.mjs"], env, join(root, "apps/dashboard"));
  await wait(async () => (await fetch(`${dashboardOrigin}/glemt-passord`)).ok);
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/etc/profiles/per-user/nori/bin/chromium",
  });
  const browserContext = await browser.newContext();
  page = await browserContext.newPage();
  page.on("request", (request: any) => {
    const url = new URL(request.url());

    if (
      request.method() === "POST" &&
      ["/tilbakestill-passord", "/tilbakestill-passord.data"].includes(url.pathname)
    ) {
      const body = new URLSearchParams(request.postData() ?? "");
      submissions.push({
        tokenPresent: !!body.get("token"),
        queryAbsent: !url.searchParams.has("token"),
      });
    }
  });
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
  assert.equal(await drainWith(HttpMailLive(undefined)), "Failed");
  rejectMail = true;
  assert.equal(await drain(), "Failed");
  rejectMail = false;

  const operator = start("bun", ["apps/backend/src/password-recovery/drain-main.ts", "--once"], {
    ...env,
    MAIL_DELIVERY_URL: `http://127.0.0.1:${mailbox.port}/mail`,
    MAIL_DELIVERY_TOKEN: mailboxToken,
    MAIL_DELIVERY_TIMEOUT_MS: "2000",
    MAIL_SENDER: "recovery@example.invalid",
  });

  assert.equal(await new Promise((resolve) => operator.once("exit", resolve)), 0);
  assert.equal(
    (await pool.query("SELECT status FROM auth.password_reset_email_outbox")).rows[0].status,
    "Delivered",
  );
  gates.push(
    "known/unknown concealment, durable acceptance, missing authority, HTTP503 retry and ACK",
  );

  const received = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
    await (
      await fetch(`http://127.0.0.1:${mailbox.port}/mail`, {
        headers: { authorization: `Bearer ${mailboxToken}` },
      })
    ).json(),
  );

  const resetUrl = received[0]!.text.match(
    /https:\/\/[^\s]+\/api\/auth\/reset-password\/[^\s]+/u,
  )?.[0];

  assert.ok(resetUrl, "password reset email contains its reset link");
  const token = new URL(resetUrl).pathname.split("/").at(-1)!;
  secrets.push(token, resetUrl);
  await page.goto(resetUrl);
  assert.equal(new URL(page.url()).pathname, "/tilbakestill-passord");
  await page.getByLabel("Nytt passord", { exact: true }).fill("x".repeat(129));
  await page.getByLabel("Gjenta passord", { exact: true }).fill("x".repeat(129));
  await page.getByRole("button", { name: "Lagre passord" }).click();
  await page.getByRole("alert").waitFor();
  await page.getByLabel("Nytt passord", { exact: true }).fill(newPassword);
  await page.getByLabel("Gjenta passord", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "Lagre passord" }).click();
  await page.waitForURL("**/login?reset=true");
  gates.push("browser policy rejection then corrected reset reaches login");

  for (const cookie of [cookie1, cookie2]) {
    const r = await fetch(`${canonicalOrigin}/api/session`, {
      headers: { cookie, origin: dashboardOrigin },
    });

    assert.equal(r.status, 401);
  }

  gates.push("both old sessions denied");
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
    `UPDATE auth.verification SET "expiresAt"=date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')-INTERVAL '1 second' WHERE identifier LIKE 'reset-password:%'`,
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
    `UPDATE auth.password_reset_email_outbox SET status='Processing',claim_id=gen_random_uuid(),claimed_at=date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')-INTERVAL '2 minutes' WHERE status='Pending'`,
  );
  assert.equal(await drain(), "Delivered");
  await requestReset();
  const simultaneous = await Promise.all([drain(), drain()]);
  assert.deepEqual(simultaneous.sort(), ["Delivered", "Empty"]);
  gates.push("stale recovery and concurrent SKIP LOCKED claims");

  const nextToken = async () => {
    assert.equal((await requestReset()).status, 200);

    const row = (
      await pool.query(
        `SELECT identifier FROM auth.verification WHERE identifier LIKE 'reset-password:%' ORDER BY "createdAt" DESC LIMIT 1`,
      )
    ).rows[0];

    const value = row.identifier.slice("reset-password:".length);
    secrets.push(value);

    return value;
  };

  const concurrentToken = await nextToken();

  const resetStatuses = await Promise.all([
    post("reset-password", { token: concurrentToken, newPassword: "Concurrent-password-A-12345" }),
    post("reset-password", { token: concurrentToken, newPassword: "Concurrent-password-B-12345" }),
  ]);

  assert.deepEqual(resetStatuses.map((r) => r.status).sort(), [200, 400]);

  const winner =
    resetStatuses[0]!.status === 200
      ? "Concurrent-password-A-12345"
      : "Concurrent-password-B-12345";

  await login(winner);
  gates.push("one consumed token, concurrent different-password reset exactly one success");
  const auditFailureToken = await nextToken();
  await pool.query(
    `CREATE FUNCTION auth.reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_kind='password-reset-success' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON auth.identity_security_audit FOR EACH ROW EXECUTE FUNCTION auth.reject_recovery_audit()`,
  );
  assert.equal(
    (await post("reset-password", { token: auditFailureToken, newPassword })).status,
    503,
  );
  await pool.query(
    `DROP TRIGGER reject_recovery_audit ON auth.identity_security_audit; DROP FUNCTION auth.reject_recovery_audit()`,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int n FROM auth.session WHERE "userId"='journey-rec-leader-0049'`,
      )
    ).rows[0].n,
    0,
  );
  const partialCookie = await login(newPassword);
  gates.push(
    "audit failure after password update and session deletion returns503; credential changed",
  );
  const deletionFailureToken = await nextToken();
  await pool.query(
    `CREATE FUNCTION auth.reject_recovery_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic session deletion failure'; END $$; CREATE TRIGGER reject_recovery_session_delete BEFORE DELETE ON auth.session FOR EACH ROW EXECUTE FUNCTION auth.reject_recovery_session_delete()`,
  );
  assert.ok(
    (await post("reset-password", { token: deletionFailureToken, newPassword: oldPassword }))
      .status >= 500,
  );
  await pool.query(
    `DROP TRIGGER reject_recovery_session_delete ON auth.session; DROP FUNCTION auth.reject_recovery_session_delete()`,
  );

  const stillLive = await fetch(`${canonicalOrigin}/api/session`, {
    headers: { cookie: partialCookie, origin: dashboardOrigin },
  });

  assert.equal(stillLive.status, 200);
  await login(oldPassword);
  gates.push("session deletion failure returns5xx; password changed with old session still live");
  const expiredToken = await nextToken();
  await pool.query(
    `UPDATE auth.verification SET "expiresAt"=date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')-INTERVAL '1 second' WHERE identifier=$1`,
    [`reset-password:${expiredToken}`],
  );
  await page.goto(
    `${canonicalOrigin}/api/auth/reset-password/${expiredToken}?callbackURL=${encodeURIComponent(`${dashboardOrigin}/tilbakestill-passord`)}`,
  );
  await page.getByText("Lenken er ugyldig eller utløpt.").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "invalid-link-mobile.png") });
  const AxeBuilder = requireDashboard("@axe-core/playwright").default;
  const axe = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(axe.violations, []);
  gates.push("actual expired token callback, mobile invalid-link view, Axe");

  for (const [id, identifier, value] of [
    [
      "invalid-verification-proof",
      "not-a-reset-identifier",
      "journey-rec-leader-0049",
      "verification-invalid",
    ],
    [
      "mismatched-verification-proof",
      "reset-password:synthetic-mismatch",
      "wrong-person",
      "authority-mismatch",
    ],
  ]) {
    await pool.query(
      `INSERT INTO auth.verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')+INTERVAL '1 hour',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
      [id, identifier, value],
    );
    await pool.query(
      `INSERT INTO auth.password_reset_email_outbox(effect_id,verification_id,subject_person_id,status) VALUES($1,$2,'journey-rec-leader-0049','Pending')`,
      [`password-reset:${id}`, id],
    );
  }

  // Drain earlier reset-consumed/expired effects first, then malformed fixtures; none can be mailed.
  for (let n = 0; n < 16; n++) {
    const result = await drain();

    if (result === "Empty") break;
    assert.equal(result, "Quarantined");
  }

  const invalid = (
    await pool.query(
      `SELECT last_failure_code FROM auth.password_reset_email_outbox WHERE verification_id IN ('invalid-verification-proof','mismatched-verification-proof') ORDER BY verification_id`,
    )
  ).rows;

  assert.deepEqual(
    invalid.map((r: any) => r.last_failure_code),
    ["verification-invalid", "authority-mismatch"],
  );
  assert.ok(submissions.length >= 2);
  assert.ok(submissions.every((item) => item.tokenPresent && item.queryAbsent));
  gates.push(
    "invalid and authority-mismatched verification quarantined; browser token only in request body",
  );

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
  await Effect.runPromise(
    Console.log(JSON.stringify({ result: "Passed", artifacts, revision, gates })),
  );
} catch (error) {
  let text = page
    ? await page
        .locator("body")
        .innerText()
        .catch(() => "")
    : "";

  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  await Effect.runPromise(
    Console.error(
      JSON.stringify({
        failure: error instanceof Error ? error.name : "Failure",
        assertion:
          error !== null &&
          (error === null || Predicate.isObjectOrArray(error)) &&
          "actual" in error &&
          "expected" in error
            ? {
                actual: Predicate.isNumber(error.actual)
                  ? error.actual
                  : Object.prototype.toString.call(error.actual),
                expected: Predicate.isNumber(error.expected)
                  ? error.expected
                  : Object.prototype.toString.call(error.expected),
              }
            : null,
        gates,
        submissions,
        pageText: text.slice(0, 1800),
        artifacts,
      }),
    ),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await mailbox?.stop(true);
  await pool?.end();

  for (const child of children.reverse()) await stopOwnedProcess(child);
  await postgres?.stop();
}
