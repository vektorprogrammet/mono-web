/** Spec0054.2: real PostgreSQL, HTTP acknowledgement mailbox and production browser journey. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Cause,
  Config,
  Console,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import { MailDeliveryRequest, Mail } from "../../packages/domain/src/mail.js";
import { loopbackPortFree, reserveLoopbackPorts, startDisposablePostgres } from "../postgres/index.ts";
import { drainPasswordResetMail } from "../../packages/database/src/password-recovery.js";
import { HttpMailLive } from "../../apps/backend/src/mail/http.js";
import { nativeRpcRequestBody, nativeRpcStatus } from "../../apps/dashboard/e2e/native-operations.js";
import { auditSettledPage } from "../../apps/dashboard/e2e/settled-axe.js";
import { jsonText } from "../../apps/backend/src/rpc/problem.js";
import {
  answersOk,
  commandOutput,
  indentedJsonText,
  ProbeFailure,
  startOwnedProcess,
} from "./acceptance-process.ts";

const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);

const requireDashboard = createRequire(
  new URL("../../apps/dashboard/package.json", import.meta.url),
);

const { Pool } = requireDatabase("pg");

const { chromium } = requireDashboard("@playwright/test");

/** A PostgreSQL call, or the disposable cluster, that failed. */
class DatabaseFailure extends Data.TaggedError("DatabaseFailure")<{ readonly cause: unknown }> {}

/** A Playwright call that failed. */
class BrowserFailure extends Data.TaggedError("BrowserFailure")<{ readonly cause: unknown }> {}

/** The rows of one query; the probe reads the columns that its statement selects. */
interface QueryResult {
  readonly rows: Array<any>;
}

/** The name and value of the first cookie that a response sets, as a `Cookie` header sends it. */
const firstCookie = (response: HttpClientResponse.HttpClientResponse): string | undefined => {
  const cookie = Object.values(response.cookies.cookies)[0];

  return cookie === undefined ? undefined : `${cookie.name}=${cookie.valueEncoded}`;
};

/** One Playwright call; the probe loads Playwright untyped, so its handles are `any`. */
const browserStep = (step: () => Promise<any>): Effect.Effect<any, BrowserFailure> =>
  Effect.tryPromise({ try: step, catch: (cause) => new BrowserFailure({ cause }) });

const MailboxMessages = Schema.Array(Schema.Struct({ text: Schema.String }));

const journey = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "../..");
  const logs: string[] = [];

  const run = (command: string, args: ReadonlyArray<string>, env = {}, cwd = root) =>
    commandOutput({ command, args, cwd, env, deadline: "180 seconds", stderr: "pipe" });

  assert.equal(
    (yield* run("git", ["status", "--porcelain"])).trim(),
    "",
    "committed clean tree required",
  );

  const revision = (yield* run("git", ["rev-parse", "HEAD"])).trim();
  const artifacts = yield* fs.makeTempDirectory({ prefix: "vektor-recovery-0054-" });

  const start = (command: string, args: ReadonlyArray<string>, env = {}, cwd = root) =>
    startOwnedProcess({ command, args, cwd, env, output: (text) => logs.push(text) });

  const wait = (url: string) =>
    answersOk(url).pipe(
      Effect.filterOrFail(
        (ready) => ready,
        () => new ProbeFailure({ message: "Readiness timeout" }),
      ),
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 149 }),
    );

  const secrets: string[] = [];
  const gates: string[] = [];
  const submissions: { tokenPresent: boolean; queryAbsent: boolean }[] = [];
  let page: any;

  const checks = Effect.gen(function* () {
    const [apiPort] = yield* Effect.tryPromise({
      try: () => reserveLoopbackPorts(1),
      catch: (cause) => new DatabaseFailure({ cause }),
    });

    const uiPort = 5174;

    assert.ok(
      yield* Effect.promise(() => loopbackPortFree(uiPort)),
      `loopback port ${uiPort} is in use`,
    );

    const postgres = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => startDisposablePostgres(),
        catch: (cause) => new DatabaseFailure({ cause }),
      }),
      (cluster) => Effect.promise(() => cluster.stop()),
    );

    const pg = postgres.url;

    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: pg })),
      (owned) => Effect.promise(() => owned.end()),
    );

    const query = (text: string, values?: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: (): Promise<QueryResult> => pool.query(text, values),
        catch: (cause) => new DatabaseFailure({ cause }),
      });

    const canonicalOrigin = `http://127.0.0.1:${apiPort}`,
      dashboardOrigin = `http://127.0.0.1:${uiPort}`;

    /** The status that `system.readSession` answers for a cookie, sent as the browser sends it. */
    const readSessionStatus = (cookie: string) =>
      HttpClient.execute(
        HttpClientRequest.post(`${canonicalOrigin}/api/rpc`, {
          headers: { cookie, origin: dashboardOrigin },
        }).pipe(
          HttpClientRequest.bodyText(
            nativeRpcRequestBody("system.readSession"),
            "application/json",
          ),
        ),
      ).pipe(
        Effect.flatMap((response) => response.text),
        Effect.map(nativeRpcStatus),
      );

    const env = {
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(apiPort),
      BACKEND_PG_URL: pg,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: yield* jsonText([dashboardOrigin]),
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

    yield* run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], env);
    yield* start("bun", ["apps/backend/src/main.ts"], env);
    yield* wait(`${canonicalOrigin}/health`);

    const email = "lina.leader@example.invalid",
      oldPassword = "journey-secret-0123456789abcdef",
      newPassword = "New-password-recovery-0123456789";

    secrets.push(email, oldPassword, newPassword);

    /** One identity-engine request that follows no redirect, waiting out a real rate limit. */
    const post = (path: string, body: Schema.Json, origin = dashboardOrigin) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(`${canonicalOrigin}/api/auth/${path}`, {
          headers: { origin },
        }).pipe(HttpClientRequest.bodyText(yield* jsonText(body), "application/json"));

        for (let attempt = 0; attempt < 4; attempt++) {
          const response = yield* HttpClient.execute(request).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          );

          if (response.status !== 429) return response;
          const retry = Number(response.headers["x-retry-after"]);
          assert.ok(
            Number.isFinite(retry) && retry >= 0 && retry <= 60,
            "bounded engine retry window",
          );
          gates.push("real credential rate limit observed; waited retry window");
          yield* Effect.sleep(Duration.millis(retry * 1000 + 100));
        }

        return yield* new ProbeFailure({ message: "Credential rate limit did not clear" });
      });

    const login = (password: string) =>
      Effect.gen(function* () {
        const response = yield* post("sign-in/email", { email, password });
        assert.equal(response.status, 200);
        const cookie = firstCookie(response);
        assert.ok(cookie !== undefined);

        return cookie;
      });

    const cookie1 = yield* login(oldPassword),
      cookie2 = yield* login(oldPassword);

    secrets.push(cookie1, cookie2);
    const messages = new Map<string, { text: string; recipient: string }>();
    let rejectMail = false;
    const mailboxToken = randomBytes(24).toString("hex");
    secrets.push(mailboxToken);

    const mailbox = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            if (request.headers.get("authorization") !== `Bearer ${mailboxToken}`)
              return new Response(null, { status: 401 });

            if (request.method === "GET") return Response.json([...messages.values()]);

            if (rejectMail) return new Response(null, { status: 503 });

            return request.json().then((json) => {
              const body = Schema.decodeUnknownSync(MailDeliveryRequest)(json);
              messages.set(body.deliveryId, body);

              return Response.json({ acknowledged: true });
            });
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );

    const delivery = HttpMailLive({
      endpoint: new URL(`http://127.0.0.1:${mailbox.port}/mail`),
      token: mailboxToken,
      deliveryTimeoutMilliseconds: 2000,
    });

    const drainWith = (provider: Layer.Layer<Mail, never, HttpClient.HttpClient>) =>
      Mail.use((mail) =>
        drainPasswordResetMail(
          pool,
          {
            oauth: {
              canonicalOrigin,
              dashboardOrigin,
              nativeApiResource: "urn:vektorprogrammet:native-api",
            },
          },
          mail,
          "recovery@example.invalid",
        ),
      ).pipe(Effect.provide(provider.pipe(Layer.provide(FetchHttpClient.layer))));

    const drain = drainWith(delivery);

    yield* run("bun", ["run", "build"], env, path.join(root, "apps/dashboard"));
    yield* start("bun", ["server.mjs"], env, path.join(root, "apps/dashboard"));
    yield* wait(`${dashboardOrigin}/glemt-passord`);

    const executablePath = yield* Config.String("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH").pipe(
      Config.withDefault("/etc/profiles/per-user/nori/bin/chromium"),
    );

    const browser = yield* Effect.acquireRelease(
      browserStep(() => chromium.launch({ headless: true, executablePath })),
      (owned) => Effect.promise(() => owned.close()),
    );

    const browserContext = yield* browserStep(() => browser.newContext());
    page = yield* browserStep(() => browserContext.newPage());
    page.on("request", (request: any) => {
      const url = new URL(request.url());

      if (
        request.method() === "POST" &&
        ["/tilbakestill-passord", "/tilbakestill-passord.data"].includes(url.pathname)
      ) {
        const body = new URLSearchParams(request.postData() ?? "");
        const token = body.get("token");
        submissions.push({
          tokenPresent: token !== null && token !== "",
          queryAbsent: !url.searchParams.has("token"),
        });
      }
    });
    const errors: string[] = [];
    page.on("pageerror", () => errors.push("Browser runtime error"));
    yield* browserStep(() => page.goto(`${dashboardOrigin}/glemt-passord`));
    yield* browserStep(() => page.getByLabel("E-post", { exact: true }).fill(email));
    yield* browserStep(() =>
      page.getByRole("button", { name: "Send tilbakestillingslenke" }).click(),
    );
    yield* browserStep(() => page.getByText("Hvis kontoen finnes", { exact: false }).waitFor());
    yield* browserStep(() => page.goto(`${dashboardOrigin}/glemt-passord`));
    yield* browserStep(() =>
      page.getByLabel("E-post", { exact: true }).fill("unknown@example.invalid"),
    );
    yield* browserStep(() =>
      page.getByRole("button", { name: "Send tilbakestillingslenke" }).click(),
    );
    yield* browserStep(() => page.getByText("Hvis kontoen finnes", { exact: false }).waitFor());
    assert.equal(
      (yield* query("SELECT count(*)::int n FROM auth.password_reset_email_outbox")).rows[0].n,
      1,
    );
    assert.equal(yield* drainWith(HttpMailLive(undefined)), "Failed");
    rejectMail = true;
    assert.equal(yield* drain, "Failed");
    rejectMail = false;

    const operator = yield* start(
      "bun",
      ["apps/backend/src/password-recovery/drain-main.ts", "--once"],
      {
        ...env,
        MAIL_DELIVERY_URL: `http://127.0.0.1:${mailbox.port}/mail`,
        MAIL_DELIVERY_TOKEN: mailboxToken,
        MAIL_DELIVERY_TIMEOUT_MS: "2000",
        MAIL_SENDER: "recovery@example.invalid",
      },
    );

    assert.equal(yield* operator.exitCode, 0);
    assert.equal(
      (yield* query("SELECT status FROM auth.password_reset_email_outbox")).rows[0].status,
      "Delivered",
    );
    gates.push(
      "known/unknown concealment, durable acceptance, missing authority, HTTP503 retry and ACK",
    );

    const received = yield* HttpClient.execute(
      HttpClientRequest.get(`http://127.0.0.1:${mailbox.port}/mail`, {
        headers: { authorization: `Bearer ${mailboxToken}` },
      }),
    ).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(MailboxMessages)),
    );

    const resetUrl = received[0]!.text.match(
      /https?:\/\/[^\s]+\/api\/auth\/reset-password\/[^\s]+/u,
    )?.[0];

    assert.ok(resetUrl !== undefined, "password reset email contains its reset link");
    const token = new URL(resetUrl).pathname.split("/").at(-1)!;
    secrets.push(token, resetUrl);
    yield* browserStep(() => page.goto(resetUrl));
    assert.equal(new URL(page.url()).pathname, "/tilbakestill-passord");
    yield* browserStep(() =>
      page.getByLabel("Nytt passord", { exact: true }).fill("x".repeat(129)),
    );
    yield* browserStep(() =>
      page.getByLabel("Gjenta passord", { exact: true }).fill("x".repeat(129)),
    );
    yield* browserStep(() => page.getByRole("button", { name: "Lagre passord" }).click());
    yield* browserStep(() => page.getByRole("alert").waitFor());
    yield* browserStep(() => page.getByLabel("Nytt passord", { exact: true }).fill(newPassword));
    yield* browserStep(() => page.getByLabel("Gjenta passord", { exact: true }).fill(newPassword));
    yield* browserStep(() => page.getByRole("button", { name: "Lagre passord" }).click());
    yield* browserStep(() => page.waitForURL("**/login?reset=true"));
    gates.push("browser policy rejection then corrected reset reaches login");

    for (const cookie of [cookie1, cookie2]) {
      assert.equal(yield* readSessionStatus(cookie), 401);
    }

    gates.push("both old sessions denied");
    assert.equal((yield* post("sign-in/email", { email, password: oldPassword })).status, 401);
    yield* login(newPassword);
    assert.equal(
      (yield* post("reset-password", { token, newPassword: oldPassword })).status,
      400,
    );
    gates.push(
      "browser callback/reset, both old sessions denied, old password denied, new login, reused token denied",
    );

    const requestReset = post("request-password-reset", {
      email,
      redirectTo: `${dashboardOrigin}/tilbakestill-passord`,
    });

    assert.equal((yield* requestReset).status, 200);
    yield* query(
      `UPDATE auth.verification SET "expiresAt"=date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')-INTERVAL '1 second' WHERE identifier LIKE 'reset-password:%'`,
    );
    assert.equal(yield* drain, "Quarantined");
    yield* browserStep(() =>
      page.goto(
        `${canonicalOrigin}/api/auth/reset-password/expired-or-malformed?callbackURL=${encodeURIComponent(`${dashboardOrigin}/tilbakestill-passord`)}`,
      ),
    );
    yield* browserStep(() => page.getByText("Lenken er ugyldig eller utløpt.").waitFor());
    assert.equal(
      (yield* post("request-password-reset", { email, redirectTo: `${dashboardOrigin}/login` }))
        .status,
      403,
    );
    assert.equal(
      (yield* post(
        "request-password-reset",
        { email, redirectTo: `${dashboardOrigin}/tilbakestill-passord` },
        "https://evil.example",
      )).status,
      403,
    );
    assert.equal(
      (yield* HttpClient.get(
        `${canonicalOrigin}/api/auth/reset-password/malformed?callbackURL=${encodeURIComponent(`${dashboardOrigin}/login`)}`,
      ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))).status,
      403,
    );
    gates.push("expired quarantine, invalid callback page, origin and callback path denial");
    yield* query(
      `CREATE FUNCTION auth.reject_recovery_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic enqueue failure'; END $$; CREATE TRIGGER reject_recovery_enqueue BEFORE INSERT ON auth.password_reset_email_outbox FOR EACH ROW EXECUTE FUNCTION auth.reject_recovery_enqueue()`,
    );
    assert.equal((yield* requestReset).status, 503);
    yield* query(
      `DROP TRIGGER reject_recovery_enqueue ON auth.password_reset_email_outbox; DROP FUNCTION auth.reject_recovery_enqueue()`,
    );
    gates.push("enqueue failure replaces swallowed engine success with503");
    yield* requestReset;
    yield* query(
      `UPDATE auth.password_reset_email_outbox SET status='Processing',claim_id=gen_random_uuid(),claimed_at=date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')-INTERVAL '2 minutes' WHERE status='Pending'`,
    );
    // An expired claim may already have sent its mail, so the drain quarantines it instead of resending.
    assert.equal(yield* drain, "Empty");
    assert.equal(
      (yield* query(
        `SELECT count(*)::int AS n FROM auth.password_reset_email_outbox WHERE status='Quarantined' AND last_failure_code='stale-claim'`,
      )).rows[0].n,
      1,
    );
    yield* requestReset;
    const simultaneous = yield* Effect.all([drain, drain], { concurrency: "unbounded" });
    assert.deepEqual(simultaneous.toSorted(), ["Delivered", "Empty"]);
    gates.push("stale claim quarantined and concurrent SKIP LOCKED claims");

    const nextToken = Effect.gen(function* () {
      assert.equal((yield* requestReset).status, 200);

      const row = (yield* query(
        `SELECT identifier FROM auth.verification WHERE identifier LIKE 'reset-password:%' ORDER BY "createdAt" DESC LIMIT 1`,
      )).rows[0];

      const value: string = row.identifier.slice("reset-password:".length);
      secrets.push(value);

      return value;
    });

    const concurrentToken = yield* nextToken;

    const resetStatuses = yield* Effect.all(
      [
        post("reset-password", {
          token: concurrentToken,
          newPassword: "Concurrent-password-A-12345",
        }),
        post("reset-password", {
          token: concurrentToken,
          newPassword: "Concurrent-password-B-12345",
        }),
      ],
      { concurrency: "unbounded" },
    );

    assert.deepEqual(
      resetStatuses.map((r) => r.status).toSorted((a, b) => a - b),
      [200, 400],
    );

    const winner =
      resetStatuses[0].status === 200
        ? "Concurrent-password-A-12345"
        : "Concurrent-password-B-12345";

    yield* login(winner);
    gates.push("one consumed token, concurrent different-password reset exactly one success");
    const auditFailureToken = yield* nextToken;
    yield* query(
      `CREATE FUNCTION auth.reject_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_kind='password-reset-success' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON auth.identity_security_audit FOR EACH ROW EXECUTE FUNCTION auth.reject_recovery_audit()`,
    );
    assert.equal(
      (yield* post("reset-password", { token: auditFailureToken, newPassword })).status,
      503,
    );
    yield* query(
      `DROP TRIGGER reject_recovery_audit ON auth.identity_security_audit; DROP FUNCTION auth.reject_recovery_audit()`,
    );
    assert.equal(
      (yield* query(
        `SELECT count(*)::int n FROM auth.session WHERE "userId"='journey-rec-leader-0049'`,
      )).rows[0].n,
      0,
    );
    const partialCookie = yield* login(newPassword);
    gates.push(
      "audit failure after password update and session deletion returns503; credential changed",
    );
    const deletionFailureToken = yield* nextToken;
    yield* query(
      `CREATE FUNCTION auth.reject_recovery_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic session deletion failure'; END $$; CREATE TRIGGER reject_recovery_session_delete BEFORE DELETE ON auth.session FOR EACH ROW EXECUTE FUNCTION auth.reject_recovery_session_delete()`,
    );
    assert.ok(
      (yield* post("reset-password", { token: deletionFailureToken, newPassword: oldPassword }))
        .status >= 500,
    );
    yield* query(
      `DROP TRIGGER reject_recovery_session_delete ON auth.session; DROP FUNCTION auth.reject_recovery_session_delete()`,
    );

    assert.equal(yield* readSessionStatus(partialCookie), 200);
    yield* login(oldPassword);
    gates.push("session deletion failure returns5xx; password changed with old session still live");
    const expiredToken = yield* nextToken;
    yield* query(
      `UPDATE auth.verification SET "expiresAt"=date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')-INTERVAL '1 second' WHERE identifier=$1`,
      [`reset-password:${expiredToken}`],
    );
    yield* browserStep(() =>
      page.goto(
        `${canonicalOrigin}/api/auth/reset-password/${expiredToken}?callbackURL=${encodeURIComponent(`${dashboardOrigin}/tilbakestill-passord`)}`,
      ),
    );
    yield* browserStep(() => page.getByText("Lenken er ugyldig eller utløpt.").waitFor());
    yield* browserStep(() => page.setViewportSize({ width: 390, height: 844 }));
    yield* browserStep(() =>
      page.screenshot({ path: path.join(artifacts, "invalid-link-mobile.png") }),
    );
    const axe = yield* browserStep(() => auditSettledPage(page));
    assert.deepEqual(axe, []);
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
    ] as const) {
      yield* query(
        `INSERT INTO auth.verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC')+INTERVAL '1 hour',date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'),date_trunc('milliseconds',CURRENT_TIMESTAMP,'UTC'))`,
        [id, identifier, value],
      );
      yield* query(
        `INSERT INTO auth.password_reset_email_outbox(effect_id,verification_id,subject_person_id,status) VALUES($1,$2,'journey-rec-leader-0049','Pending')`,
        [`password-reset:${id}`, id],
      );
    }

    // Drain earlier reset-consumed/expired effects first, then malformed fixtures; none can be mailed.
    for (let n = 0; n < 16; n++) {
      const result = yield* drain;

      if (result === "Empty") break;
      assert.equal(result, "Quarantined");
    }

    const invalid = (yield* query(
      `SELECT last_failure_code FROM auth.password_reset_email_outbox WHERE verification_id IN ('invalid-verification-proof','mismatched-verification-proof') ORDER BY verification_id`,
    )).rows;

    assert.deepEqual(
      invalid.map((r: any) => r.last_failure_code),
      ["verification-invalid", "authority-mismatch"],
    );
    assert.ok(submissions.length >= 2);
    assert.ok(submissions.every((item) => item.tokenPresent && item.queryAbsent));
    gates.push(
      "invalid and authority-mismatched verification quarantined; browser token only in request body",
    );

    const audits = (yield* query(
      "SELECT event_kind,subject_person_id,details,request_correlation FROM auth.identity_security_audit ORDER BY occurred_at",
    )).rows;

    const outbox = (yield* query("SELECT * FROM auth.password_reset_email_outbox")).rows;
    const safe = yield* jsonText({ audits, outbox, logs });

    for (const secret of secrets) assert.ok(!safe.includes(secret), "sensitive value leaked");
    assert.ok(audits.some((r: any) => r.event_kind === "password-reset-success"));
    assert.deepEqual(errors, []);
    yield* browserStep(() => page.goto(`${dashboardOrigin}/tilbakestill-passord`));
    yield* browserStep(() => page.screenshot({ path: path.join(artifacts, "invalid-link.png") }));
    yield* fs.writeFileString(
      path.join(artifacts, "evidence.json"),
      yield* indentedJsonText({
        revision,
        gates,
        audits: audits.map((r: any) => ({
          eventKind: r.event_kind,
          outcome: r.details.outcomeCode,
        })),
        outbox: outbox.map((r: any) => ({ status: r.status, attempts: r.attempts })),
        browserErrors: errors,
        transport: "synthetic authenticated loopback HTTP mailbox; not production email",
      }),
    );
    yield* Console.log(yield* jsonText({ result: "Passed", artifacts, revision, gates }));
  });

  /** The redacted report of a failure, written before the browser and processes are released. */
  const report = (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      const error = Cause.squash(cause);

      let text =
        page === undefined
          ? ""
          : yield* Effect.promise(
              (): Promise<string> =>
                page
                .locator("body")
                .innerText()
                .catch(() => ""),
            );

      for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
      yield* Console.error(
        yield* jsonText({
          failure: error instanceof Error ? error.name : "Failure",
          assertion:
            Predicate.isObjectOrArray(error) && "actual" in error && "expected" in error
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
      );
    });

  yield* checks.pipe(Effect.tapCause(report), Effect.scoped);
});

// The failure report above is the redacted evidence; the runtime's own report could print secrets.
BunRuntime.runMain(
  journey.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
  { disableErrorReporting: true },
);
