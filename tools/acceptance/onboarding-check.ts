import { createServer as httpServer } from "node:http";
/** 0099 real local API + browser acceptance. Reuses native identity seed and owned process lifecycle. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { stopOwnedProcess } from "./owned-process.js";
import {
  type DisposablePostgres,
  loopbackPortFree,
  reserveLoopbackPorts,
  startDisposablePostgres,
} from "../postgres/index.ts";
import { Predicate, Schema } from "effect";

const root = new URL("../../", import.meta.url).pathname;

const requireDatabase = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);

const { Pool } = requireDatabase("pg");

const run = (command: string, args: string[], env = process.env, timeout = 60_000) =>
  execFileSync(command, args, { cwd: root, env, encoding: "utf8", timeout });

const mode = process.argv[2];

assert.ok(
  process.argv.length === 3 && (mode === "--browser" || mode === "--api-only"),
  "Usage: bun run tools/acceptance/onboarding-check.ts --browser | --api-only",
);

const revision = run("git", ["rev-parse", "HEAD"]).trim();

assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "requires committed clean artifact");

const artifacts = await mkdtemp(join(tmpdir(), "vektor-onboarding-0099-"));

const children: ReturnType<typeof spawn>[] = [];

const outputs: string[] = [];

const secrets = new Set<string>();

const safe = (text: string) => {
  let value = text.replace(/onboard_[a-f0-9]{64}/g, "[REDACTED]");

  for (const secret of secrets)
    if (secret.length > 4) value = value.split(secret).join("[REDACTED]");

  return value;
};

const assertNoSecrets = (text: string) => {
  if (safe(text) !== text) throw new Error("Retained evidence contains credentials");
};

const runBrowser = async (args: string[], env: NodeJS.ProcessEnv) => {
  const child = spawn("bun", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));

  const timer = setTimeout(() => {
    void stopOwnedProcess(child);
  }, 300000);

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("Browser child failed to start")));
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Browser journey failed: " + safe(output))),
      );
    });
  } finally {
    clearTimeout(timer);
  }
};

const start = (command: string, args: string[], env = process.env) => {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout?.on("data", (chunk) => outputs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => outputs.push(String(chunk)));

  return child;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let postgres: DisposablePostgres | undefined;

let pool: InstanceType<typeof Pool> | undefined;

let evidence: Schema.JsonObject | undefined;

const mailboxToken = randomBytes(32).toString("hex");

secrets.add(mailboxToken);

const mail = new Map<string, { deliveryId: string; text: string; to: string }>();

let mailbox: ReturnType<typeof httpServer> | undefined;

let attempts = 0;

let rejectNext = false;

try {
  const [backendPort, mailboxPort] = await reserveLoopbackPorts(2);
  const dashboardPort = 5174;
  assert.ok(await loopbackPortFree(dashboardPort), `loopback port ${dashboardPort} is in use`);
  postgres = await startDisposablePostgres();
  const postgresUrl = postgres.url;
  secrets.add(postgresUrl);
  pool = new Pool({ connectionString: postgresUrl });

  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;
  mailbox = httpServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${mailboxToken}`) {
      res.writeHead(401).end();

      return;
    }

    let body = "";

    for await (const chunk of req) body += chunk;

    if (req.method === "POST") {
      attempts++;

      if (rejectNext) {
        rejectNext = false;
        res.writeHead(503).end();

        return;
      }

      const parsed = JSON.parse(body);
      const old = mail.get(parsed.deliveryId);

      if (old && JSON.stringify(old) !== JSON.stringify(parsed)) {
        res.writeHead(409).end();

        return;
      }

      mail.set(parsed.deliveryId, parsed);
      res.writeHead(204).end();

      return;
    }

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([...mail.values()]));
  });
  await new Promise<void>((resolve) => mailbox!.listen(mailboxPort, "127.0.0.1", resolve));
  const mailboxOrigin = `http://127.0.0.1:${mailboxPort}`;

  const environment = {
    ...process.env,
    ONBOARDING_DELIVERY_URL: mailboxOrigin + "/mail",
    ONBOARDING_DELIVERY_TOKEN: mailboxToken,
    ONBOARDING_DELIVERY_TIMEOUT_MS: "1000",
    ONBOARDING_DELIVERY_SENDER: "coordinator@example.invalid",
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
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
    JOURNEY_SEED_PG_URL: postgresUrl,
  };

  secrets.add(environment.BETTER_AUTH_SECRET);

  for (const key of Object.keys(environment))
    if (
      key.startsWith("CONTACT_") ||
      (key.startsWith("PUBLIC_APPLICATION_EFFECT_") && key !== "PUBLIC_APPLICATION_EFFECT_MODE")
    )
      Reflect.deleteProperty(environment, key);
  run("bun", ["apps/dashboard/e2e/native-recruitment-journey-seed.mjs"], environment);
  const departmentId = "department-native-journey-0049";
  const semesterId = "semester-native-journey-0049";
  const leaderId = "journey-rec-leader-0049";
  secrets.add(environment.BETTER_AUTH_SECRET);

  const persons = {
    leader: { email: "lina.leader@example.invalid", password: "journey-secret-0123456789abcdef" },
    existing: {
      email: "irene.intervjuer@example.invalid",
      password: "journey-secret-0123456789abcdef",
    },
    applicant: {
      email: "onboarding-browser@example.invalid",
      password: "onboarding-browser-password-0099",
    },
  };

  for (const person of Object.values(persons)) secrets.add(person.password);
  await pool.query(
    `DELETE FROM organization_global_administrator_grants;INSERT INTO schools_directory_schools(school_id,name,contact_person,email,phone,language,active,revision) OVERRIDING SYSTEM VALUE VALUES(995,'Onboarding school','Contact','school@example.invalid','12345678','Norwegian',true,0);INSERT INTO schools_directory_departments VALUES(995,'${departmentId}',0);`,
  );
  let backend = start("bun", ["run", "--cwd", "apps/backend", "start"], environment);

  const ready = async () => {
    for (let n = 0; ; n++) {
      try {
        if ((await fetch(backendOrigin + "/health")).ok) return;
      } catch {}

      if (n > 150) throw Error("backend startup failed");
      await delay(200);
    }
  };

  await ready();

  const request = (
    path: string,
    cookie?: string,
    body?: Schema.Json,
    etag?: string,
    key = randomBytes(18).toString("hex"),
  ) => {
    const nativeHeaders = new Headers();
    nativeHeaders.set("origin", dashboardOrigin);

    if (cookie) {
      nativeHeaders.set("cookie", cookie);
    }

    if (!(body === undefined)) {
      nativeHeaders.set("content-type", "application/json");
      nativeHeaders.set("idempotency-key", key);

      if (etag) {
        nativeHeaders.set("if-match", etag);
      }
    }

    const requestBody: Pick<RequestInit, "body"> =
      body === undefined ? {} : { body: JSON.stringify(body) };

    return fetch(backendOrigin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: nativeHeaders,
      ...requestBody,
    });
  };

  const expectStatus = async (response: Response, status: number) => {
    const body = await response.json();
    assert.equal(
      response.status,
      status,
      Predicate.isString(body.code) && /^[a-z.-]+$/.test(body.code)
        ? body.code
        : "Unexpected HTTP status",
    );

    return body;
  };

  const login = async (person: { email: string; password: string }) => {
    const response = await request("/api/auth/sign-in/email", undefined, person);
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);

    return cookie;
  };

  const leader = await login(persons.leader);
  const existing = await login(persons.existing);
  const boardPath = "/api/onboarding?departmentId=" + departmentId;
  const board = async () => expectStatus(await request(boardPath, leader), 200);

  const submit = async (email: string, firstName: string) =>
    expectStatus(
      await request("/api/applications", undefined, {
        departmentId,
        firstName,
        lastName: "Applicant",
        phone: "12345678",
        email,
        gender: 0,
        fieldOfStudyId: "field-native-journey-0049",
        yearOfStudy: 2,
        availability: {
          mondayUnavailable: false,
          tuesdayUnavailable: true,
          wednesdayUnavailable: false,
          thursdayUnavailable: false,
          fridayUnavailable: false,
          positionWeeks: 4,
          preferredGroup: "all",
          language: "Norsk",
        },
      }),
      201,
    );

  const browserApplication = await submit(persons.applicant.email, "Onboarding");
  let revokedReplayObserved = false;

  const issue = async (applicationId: string) => {
    const before = await board();
    const key = randomBytes(18).toString("hex");
    const body = { applicationId, action: "Issue" };
    const response = await request(boardPath, leader, body, before.etag, key);
    await expectStatus(response, 200);
    const count = mail.size;
    await expectStatus(await request(boardPath, leader, body, before.etag, key), 200);
    assert.equal(mail.size, count);

    if (!revokedReplayObserved) {
      await pool.query(`UPDATE organization_memberships SET is_suspended=true WHERE person_id=$1`, [
        leaderId,
      ]);

      try {
        await expectStatus(await request(boardPath, leader, body, before.etag, key), 403);
        await expectStatus(await request(boardPath, leader), 403);
      } finally {
        await pool.query(
          `UPDATE organization_memberships SET is_suspended=false WHERE person_id=$1`,
          [leaderId],
        );
      }

      revokedReplayObserved = true;
    }

    await expectStatus(
      await request(boardPath, leader, { applicationId, action: "Revoke" }, before.etag, key),
      409,
    );

    return [...mail.values()].at(-1)!;
  };

  await expectStatus(await request(boardPath, existing), 403);
  await expectStatus(await request(boardPath), 401);
  await pool.query(
    `INSERT INTO organization_departments(department_id,name,short_name,email,city,active,revision) VALUES('onboarding-wrong-dept','Other','Other','other@example.invalid','Other',true,0)`,
  );
  await expectStatus(
    await request("/api/onboarding?departmentId=onboarding-wrong-dept", leader),
    403,
  );

  const existingApplication = await submit("onboarding-existing@example.invalid", "Existing");

  const prior = (
    await pool.query(
      `SELECT jsonb_build_object('user',u,'account',a,'profile',p)::text AS value FROM auth."user" u JOIN auth."account" a ON a."userId"=u.id JOIN person_profiles p ON p.person_id=u.id WHERE u.id='journey-rec-interviewer-a-0049'`,
    )
  ).rows;

  const invitation = await issue(existingApplication.applicationId);
  const token = new URL(invitation.text.split(" ").at(-1)!).hash.slice(1);
  await expectStatus(
    await request("/api/onboarding/claim", undefined, { mode: "ExistingAccount", token }),
    401,
  );
  await expectStatus(
    await request("/api/onboarding/claim", existing, { mode: "ExistingAccount", token }),
    200,
  );
  await expectStatus(
    await request("/api/onboarding/claim", existing, { mode: "ExistingAccount", token }),
    400,
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT jsonb_build_object('user',u,'account',a,'profile',p)::text AS value FROM auth."user" u JOIN auth."account" a ON a."userId"=u.id JOIN person_profiles p ON p.person_id=u.id WHERE u.id='journey-rec-interviewer-a-0049'`,
      )
    ).rows,
    prior,
  );
  const collisionApplication = await submit(persons.existing.email, "Collision");
  const collision = await issue(collisionApplication.applicationId);
  const collisionToken = new URL(collision.text.split(" ").at(-1)!).hash.slice(1);
  await expectStatus(
    await request("/api/onboarding/claim", undefined, {
      mode: "NewAccount",
      token: collisionToken,
      password: persons.applicant.password,
    }),
    409,
  );
  const concurrentApplication = await submit("onboarding-concurrent@example.invalid", "Concurrent");
  const concurrent = await issue(concurrentApplication.applicationId);
  const concurrentToken = new URL(concurrent.text.split(" ").at(-1)!).hash.slice(1);

  const claims = await Promise.all([
    request("/api/onboarding/claim", undefined, {
      mode: "NewAccount",
      token: concurrentToken,
      password: persons.applicant.password,
    }),
    request("/api/onboarding/claim", undefined, {
      mode: "NewAccount",
      token: concurrentToken,
      password: persons.applicant.password,
    }),
  ]);

  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 400]);
  const retryApplication = await submit("onboarding-retry@example.invalid", "Retry");
  rejectNext = true;
  const pre = await board();
  await expectStatus(
    await request(
      boardPath,
      leader,
      { applicationId: retryApplication.applicationId, action: "Issue" },
      pre.etag,
    ),
    200,
  );
  assert.equal(
    (await board()).items.find(
      (item: { applicationId: string }) => item.applicationId === retryApplication.applicationId,
    ).delivery,
    "Pending",
  );
  await stopOwnedProcess(backend);
  backend = start("bun", ["run", "--cwd", "apps/backend", "start"], environment);
  await ready();
  const retryPre = await board();
  await expectStatus(
    await request(
      boardPath,
      leader,
      { applicationId: retryApplication.applicationId, action: "RetryDelivery" },
      retryPre.etag,
    ),
    200,
  );
  assert.equal(
    (await board()).items.find(
      (item: { applicationId: string }) => item.applicationId === retryApplication.applicationId,
    ).delivery,
    "Delivered",
  );
  const revokePre = await board();
  await expectStatus(
    await request(
      boardPath,
      leader,
      { applicationId: retryApplication.applicationId, action: "Revoke" },
      revokePre.etag,
    ),
    200,
  );

  const revoked = [...mail.values()].find(
    (item) => item.to === "onboarding-retry@example.invalid",
  )!;

  await expectStatus(
    await request("/api/onboarding/claim", undefined, {
      mode: "NewAccount",
      token: new URL(revoked.text.split(" ").at(-1)!).hash.slice(1),
      password: persons.applicant.password,
    }),
    400,
  );
  const rollbackApplication = await submit("onboarding-rollback@example.invalid", "Rollback");
  const rollbackInvite = await issue(rollbackApplication.applicationId);
  const rollbackToken = new URL(rollbackInvite.text.split(" ").at(-1)!).hash.slice(1);
  await pool.query(
    `CREATE FUNCTION public.reject_onboarding_test_credential() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM auth."user" WHERE id=NEW."userId" AND email='onboarding-rollback@example.invalid') THEN RAISE EXCEPTION 'synthetic credential write rejection'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_onboarding_test_credential BEFORE INSERT ON auth."account" FOR EACH ROW EXECUTE FUNCTION public.reject_onboarding_test_credential()`,
  );

  try {
    await expectStatus(
      await request("/api/onboarding/claim", undefined, {
        mode: "NewAccount",
        token: rollbackToken,
        password: persons.applicant.password,
      }),
      500,
    );
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM person_contact_profiles WHERE email='onboarding-rollback@example.invalid'`,
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM auth."user" WHERE email='onboarding-rollback@example.invalid'`,
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await pool.query(
      `DROP TRIGGER reject_onboarding_test_credential ON auth."account"; DROP FUNCTION public.reject_onboarding_test_credential()`,
    );
  }

  await expectStatus(
    await request("/api/onboarding/claim", undefined, {
      mode: "NewAccount",
      token: rollbackToken,
      password: persons.applicant.password,
    }),
    200,
  );
  const expiring = await submit("onboarding-expiry@example.invalid", "Expiry");
  const expiryToken = "onboard_" + randomBytes(32).toString("hex");
  const expiryDigest = createHash("sha256").update(expiryToken).digest("hex");
  await pool.query(
    `INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) SELECT 'expiry-race',application_id,applicant_id,$2,date_trunc('milliseconds',clock_timestamp(),'UTC')+interval '3 seconds','Open',$3,date_trunc('milliseconds',clock_timestamp(),'UTC')-interval '24 hours'+interval '3 seconds' FROM admission_applications WHERE application_id=$1`,
    [expiring.applicationId, expiryDigest, leaderId],
  );
  await pool.query(
    `INSERT INTO applicant_account_delivery(invitation_id,state,recipient) VALUES('expiry-race','Delivered','onboarding-expiry@example.invalid')`,
  );
  const holder = await pool.connect();
  await holder.query("BEGIN");
  await holder.query(
    `SELECT p.applicant_id FROM admission_applicants p JOIN admission_applications a USING(applicant_id) WHERE a.application_id=$1 FOR UPDATE OF p`,
    [expiring.applicationId],
  );

  try {
    const delayed = request("/api/onboarding/claim", undefined, {
      mode: "NewAccount",
      token: expiryToken,
      password: persons.applicant.password,
    });

    for (let n = 0; ; n++) {
      const waiting = await pool.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%admission_applicants%'`,
      );

      if (waiting.rows[0].count > 0) break;

      if (n > 100) throw new Error("Claim did not wait on applicant lock");
      await delay(20);
    }

    for (;;) {
      const expired = await pool.query(
        `SELECT expires_at<clock_timestamp() AS expired FROM applicant_account_invitations WHERE invitation_id='expiry-race'`,
      );

      if (expired.rows[0].expired) break;
      await delay(30);
    }

    await holder.query("COMMIT");
    await expectStatus(await delayed, 400);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }

  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int AS count FROM auth."user" WHERE email='onboarding-expiry@example.invalid'`,
      )
    ).rows[0].count,
    0,
  );
  // Expiry is enforced immediately; physical secret cleanup belongs to the backend lifetime.
  const cleanupApplication = await submit("onboarding-cleanup@example.invalid", "Cleanup");
  await stopOwnedProcess(backend);
  // Seed an already-expired pending effect; invitation timestamps are immutable.
  const cleanupId = "expiry-cleanup";
  const cleanupToken = "onboard_" + randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO applicant_account_invitations(invitation_id,application_id,applicant_id,token_digest,expires_at,state,issued_by,issued_at) SELECT $2,application_id,applicant_id,$3,date_trunc('milliseconds',clock_timestamp(),'UTC')-interval '1 second','Open',$4,date_trunc('milliseconds',clock_timestamp(),'UTC')-interval '24 hours 1 second' FROM admission_applications WHERE application_id=$1`,
    [
      cleanupApplication.applicationId,
      cleanupId,
      createHash("sha256").update(cleanupToken).digest("hex"),
      leaderId,
    ],
  );
  await pool.query(
    `INSERT INTO applicant_account_delivery(invitation_id,state,recipient,secret,envelope) VALUES($1,'Pending','onboarding-cleanup@example.invalid',$2,'{}'::jsonb)`,
    [cleanupId, cleanupToken],
  );
  await pool.query(`CREATE FUNCTION public.reject_onboarding_expiry_rehearsal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic expiry cleanup failure'; END $$;
    CREATE TRIGGER reject_onboarding_expiry_rehearsal BEFORE UPDATE ON applicant_account_delivery FOR EACH ROW WHEN (OLD.state='Pending' AND NEW.state='Cancelled') EXECUTE FUNCTION public.reject_onboarding_expiry_rehearsal()`);
  backend = start("bun", ["run", "--cwd", "apps/backend", "start"], environment);

  const failedWorkerExit = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("expiry worker failure did not stop backend")),
      30000,
    );

    backend.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  assert.equal(failedWorkerExit, 1, "unexpected expiry worker failure must not report success");
  await pool.query(
    "DROP TRIGGER reject_onboarding_expiry_rehearsal ON applicant_account_delivery; DROP FUNCTION public.reject_onboarding_expiry_rehearsal()",
  );
  backend = start("bun", ["run", "--cwd", "apps/backend", "start"], environment);
  await ready();

  for (let attempt = 0; ; attempt++) {
    const cleaned = (
      await pool.query(
        "SELECT state, secret IS NULL AS secret_removed, envelope IS NULL AS envelope_removed FROM applicant_account_delivery WHERE invitation_id=$1",
        [cleanupId],
      )
    ).rows[0];

    if (cleaned.state === "Cancelled" && cleaned.secret_removed && cleaned.envelope_removed) break;
    assert.ok(attempt < 50, "startup expiry cleanup must erase the pending secret");
    await delay(100);
  }

  const manifest = {
    revision,
    backendOrigin,
    dashboardOrigin,
    artifacts,
    departmentId,
    semesterId,
    schoolId: 995,
    persons,
    applicationId: browserApplication.applicationId,
    mailboxOrigin,
    mailboxToken,
  };

  const manifestPath = join(artifacts, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  let browserEvidence: Schema.Json = null;

  if (mode === "--browser") {
    await runBrowser(["apps/dashboard/e2e/run-real-native-onboarding.mjs"], {
      ...environment,
      ONBOARDING_JOURNEY_MANIFEST: manifestPath,
    });
    browserEvidence = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
      await readFile(join(artifacts, "browser-evidence.json"), "utf8"),
    );

    const observed = (
      await pool.query(
        `SELECT l.person_id FROM applicant_account_links l JOIN admission_applicants a USING(applicant_id) WHERE a.email=$1`,
        [persons.applicant.email],
      )
    ).rows;

    assert.equal(observed.length, 1);
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM assistant_placements WHERE person_id=$1 AND active`,
          [observed[0].person_id],
        )
      ).rows[0].count,
      1,
    );
  }

  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int AS count FROM applicant_account_delivery WHERE state IN ('Delivered','Cancelled') AND (secret IS NOT NULL OR envelope IS NOT NULL)`,
      )
    ).rows[0].count,
    0,
  );
  evidence = {
    revision,
    passed: true,
    mode,
    browserEvidence,
    mailAttempts: attempts,
    acceptedDeliveries: mail.size,
    gates: [
      "public application native authority",
      "scoped coordinator invitation and idempotency conflict",
      "wrong department, inactive issuer and revoked receipt replay denied",
      "real credential write failure rolls back account/profile/link/consumption",
      "existing claim preserves profile/credentials",
      "email collision rejected",
      "concurrent claim one account",
      "failed delivery restart retry",
      "revoked and consumed token rejected",
      "terminal secret cleanup",
      "expired pending secret erased on restart; failed expiry worker exits nonzero",
      "claim rejects expiry crossed while waiting for applicant lock",
    ],
    scope: "synthetic loopback only",
  };
} catch (error) {
  throw new Error(safe(error instanceof Error ? error.message : "Onboarding runtime failed"));
} finally {
  if (pool) await pool.end();

  for (const child of children.reverse()) await stopOwnedProcess(child);

  if (mailbox) await new Promise<void>((resolve) => mailbox!.close(() => resolve()));
  await postgres?.stop();
  await rm(join(artifacts, "manifest.json"), { force: true });

  if (evidence) {
    assertNoSecrets(JSON.stringify(evidence));
    await writeFile(
      join(artifacts, "evidence.json"),
      JSON.stringify(
        { ...evidence, cleanup: "owned processes and credential manifest removed" },
        null,
        2,
      ),
    );
    process.stdout.write(join(artifacts, "evidence.json") + "\n");
  }
}
