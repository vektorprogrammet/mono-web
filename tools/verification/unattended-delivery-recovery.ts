import { Predicate, Schema } from "effect";
import { setTimeout as pause } from "node:timers/promises";
import { createServer as createHttpServer } from "node:http";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";

const root = new URL("../../", import.meta.url).pathname;

const safeEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH"].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]!]],
  ),
);

const run = (command: string, args: string[], env = safeEnvironment) =>
  execFileSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

assert.equal(run("git", ["status", "--porcelain"]).trim(), "", "requires committed source");

const revision = run("git", ["rev-parse", "HEAD"]).trim();

const sourceTree = run("git", ["rev-parse", "HEAD^{tree}"]).trim();

const artifacts = await mkdtemp(join(tmpdir(), "vektor-delivery-recovery-"));

const privateRoot = join(artifacts, "private");

await mkdir(privateRoot, { mode: 0o700 });

process.stdout.write(`evidence: ${artifacts}\n`);

const port = async () => {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && !Predicate.isString(address));
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;

  return address.port;
};

const eventually = async (label: string, inspect: () => Promise<boolean>, timeout = 20_000) => {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await inspect()) return;
    await pause(50);
  }

  throw new Error(`Observation timeout: ${label}`);
};

interface NativeProcess {
  child: ChildProcess;
  logs: string[];
  exited: Promise<number | null>;
}

const processes: NativeProcess[] = [];

const start = (env: NodeJS.ProcessEnv) => {
  const child = spawn(process.execPath, ["--no-env-file", "apps/backend/src/main.ts"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs: string[] = [];
  child.stdout!.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr!.on("data", (chunk) => logs.push(String(chunk)));
  const exit = Promise.withResolvers<number | null>();
  child.once("error", exit.reject);
  child.once("exit", exit.resolve);
  const exited = exit.promise;
  const owned = { child, logs, exited };
  processes.push(owned);

  return owned;
};

const stop = async (process: NativeProcess, signal: NodeJS.Signals = "SIGTERM") => {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill(signal);

  const code = await Promise.race([
    process.exited,
    pause(10_000).then(() => {
      throw new Error("Native shutdown timeout");
    }),
  ]);

  if (signal === "SIGTERM") assert.equal(code, 0, "graceful shutdown");
};

const pgPort = await port();

const apiPort = await port();

const dashboardPort = await port();

const pgDirectory = join(privateRoot, "postgres");

const postgresUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;

const origin = `http://127.0.0.1:${apiPort}`;

const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

const providerToken = randomBytes(24).toString("hex");

const secret = randomBytes(32).toString("hex");

const password = randomBytes(24).toString("hex");

const person = "delivery-recovery-person";

const email = "delivery-recovery@example.invalid";

const department = "delivery-recovery-department";

type Mode = "failure" | "accept" | "hold";

let resetMode: Mode = "failure";

let receiptMode: Mode = "failure";

const attempts: Array<{ kind: "reset" | "receipt"; id: string; hash: string; accepted: boolean }> =
  [];

const held: Array<() => void> = [];

const poison = new Set<string>();

const provider = createHttpServer(async (request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${providerToken}`);
  let payload = "";

  for await (const chunk of request) payload += String(chunk);
  const body = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ deliveryId: Schema.String })),
  )(payload);
  const kind = request.url === "/reset" ? "reset" : "receipt";
  const mode = poison.has(body.deliveryId) ? "failure" : kind === "reset" ? resetMode : receiptMode;
  assert.equal(request.headers["idempotency-key"], body.deliveryId);
  attempts.push({
    kind,
    id: body.deliveryId,
    hash: createHash("sha256").update(payload).digest("hex"),
    accepted: mode === "accept",
  });

  if (mode === "hold") {
    const pending = Promise.withResolvers<void>();
    held.push(pending.resolve);
    await pending.promise;
  }

  response.writeHead(mode === "failure" ? 503 : 204);
  response.end();
});

const providerReady = Promise.withResolvers<void>();

provider.once("error", providerReady.reject);

provider.listen(0, "127.0.0.1", providerReady.resolve);

await providerReady.promise;

const providerAddress = provider.address();

assert.ok(providerAddress && !Predicate.isString(providerAddress));

const providerPort = providerAddress.port;

const env: NodeJS.ProcessEnv = {
  ...safeEnvironment,
  BACKEND_HOST: "127.0.0.1",
  BACKEND_PORT: String(apiPort),
  BACKEND_PG_URL: postgresUrl,
  BETTER_AUTH_SECRET: secret,
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify([dashboardOrigin]),
  OAUTH_CANONICAL_ORIGIN: origin,
  OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  RECRUITMENT_NOTIFICATION_MODE: "disabled",
  SCHOOL_SERVICE_NOTIFICATION_MODE: "disabled",
  SCHOOL_SERVICE_DISPATCH_NOTIFICATION_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "http",
  PASSWORD_RESET_DELIVERY_POLL_MS: "2000",
  MAIL_SENDER: "recovery@example.invalid",
  MAIL_DELIVERY_URL: `http://127.0.0.1:${providerPort}/reset`,
  MAIL_DELIVERY_TOKEN: providerToken,
  MAIL_DELIVERY_TIMEOUT_MS: "30000",
  RECEIPT_DELIVERY_MODE: "http",
  RECEIPT_DELIVERY_POLL_MS: "10000",
  RECEIPT_DELIVERY_URL: `http://127.0.0.1:${providerPort}/receipt`,
  RECEIPT_DELIVERY_TOKEN: providerToken,
  RECEIPT_DELIVERY_TIMEOUT_MS: "30000",
  RECEIPT_DELIVERY_SENDER: "receipts@example.invalid",
  RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: JSON.stringify({ [department]: "economy@example.invalid" }),
  RECEIPT_STAGING_ROOT: join(privateRoot, "staging"),
  RECEIPT_COMMITTED_ROOT: join(privateRoot, "committed"),
};

const pool = new Pool({
  connectionString: postgresUrl,
  application_name: "delivery-recovery-observer",
});

const checks: string[] = [];

let postgresStarted = false;

let current: NativeProcess | undefined;

let cookie = "";

const boot = async (changes: NodeJS.ProcessEnv = {}) => {
  current = start({ ...env, ...changes });
  await eventually("native listener", async () => {
    assert.equal(current!.child.exitCode, null, "native process stays alive");

    try {
      return (await fetch(`${origin}/health`)).ok;
    } catch {
      return false;
    }
  });

  return current;
};

const resetRows = async () =>
  (
    await pool.query(
      "SELECT effect_id,verification_id,status,attempts,claim_id,payload_sha256,last_failure_code FROM auth.password_reset_email_outbox ORDER BY created_at,effect_id",
    )
  ).rows;

const receiptRows = async () =>
  (
    await pool.query(
      "SELECT effect_id,receipt_id,status,attempts,claim_id,payload_json,delivery_envelope FROM economy_receipt_outbox ORDER BY receipt_id,ordinal",
    )
  ).rows;

const resetRequest = async () => {
  const response = await fetch(`${origin}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { origin: dashboardOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email, redirectTo: `${dashboardOrigin}/tilbakestill-passord` }),
  });

  assert.equal(response.status, 200, "real reset request accepted");

  return (await resetRows()).at(-1)!;
};

const receiptRequest = async () => {
  const form = new FormData();
  form.set("description", "Disposable delivery recovery proof");
  form.set("amountOre", "500");
  form.set("receiptDate", new Date().toISOString().slice(0, 10));
  form.set(
    "file",
    new File(["%PDF-1.4\nDisposable receipt\n%%EOF"], "receipt.pdf", { type: "application/pdf" }),
  );

  const response = await fetch(`${origin}/api/receipts?departmentId=${department}`, {
    method: "POST",
    headers: { cookie, origin: dashboardOrigin, "idempotency-key": randomUUID() },
    body: form,
  });

  assert.equal(response.status, 201, "real receipt submission accepted");

  return Schema.decodeUnknownSync(Schema.Struct({ receiptId: Schema.String }))(
    await response.json(),
  ).receiptId;
};

const business = async () =>
  (
    await pool.query(`SELECT (SELECT count(*)::int FROM economy_receipts) AS receipts,
  (SELECT count(*)::int FROM economy_receipt_command_receipts) AS commands,
  (SELECT count(*)::int FROM economy_receipt_audit) AS audit,
  (SELECT count(*)::int FROM auth.identity_security_audit WHERE event_kind='password-reset-request-accepted') AS resets,
  (SELECT count(*)::int FROM auth.verification WHERE identifier LIKE 'reset-password:%') AS verifications`)
  ).rows[0];

try {
  run("initdb", [
    "-D",
    pgDirectory,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  run("pg_ctl", [
    "-D",
    pgDirectory,
    "-l",
    join(privateRoot, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${pgPort} -k ${privateRoot}`,
    "-w",
    "start",
  ]);
  postgresStarted = true;
  run(process.execPath, ["--no-env-file", "packages/database/runtime/identity-seed-main.ts"], {
    ...env,
    IDENTITY_SEED_PG_URL: postgresUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify([
      { personId: person, firstName: "Recovery", lastName: "Proof", email, password },
    ]),
  });
  // Prerequisites only: no receipt, reset verification, command receipt, or delivery outcome is seeded.
  await pool.query(
    "INSERT INTO organization_departments(department_id,name) VALUES($1,'Recovery proof')",
    [department],
  );
  await pool.query(
    "INSERT INTO organization_teams(team_id,department_id,name) VALUES('delivery-recovery-team',$1,'Recovery proof')",
    [department],
  );
  await pool.query(
    "INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,is_team_leader) VALUES('delivery-recovery-membership',$1,'delivery-recovery-team',CURRENT_TIMESTAMP-INTERVAL '1 day',false)",
    [person],
  );
  await pool.query(
    "INSERT INTO person_contact_profiles(person_id,email,phone) VALUES($1,$2,'90000000')",
    [person, email],
  );
  await pool.query(
    "INSERT INTO economy_payment_authorities(payment_authority_id,person_id,department_id,payment_account_ciphertext,start_at,revision) VALUES('delivery-recovery-payment',$1,$2,'synthetic:delivery-recovery',CURRENT_TIMESTAMP-INTERVAL '1 day',0)",
    [person, department],
  );
  await boot();

  const login = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: dashboardOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  assert.equal(login.status, 200);
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const reset = await resetRequest();
  const receiptId = await receiptRequest();
  await eventually(
    "both durable failures",
    async () =>
      (await resetRows()).some(
        (row) => row.effect_id === reset.effect_id && row.status === "Failed",
      ) &&
      (await receiptRows()).some((row) => row.receipt_id === receiptId && row.status === "Failed"),
  );
  await stop(current!);
  const before = await business();
  const failedReset = (await resetRows()).find((row) => row.effect_id === reset.effect_id)!;

  const failedReceipt = (await receiptRows()).find(
    (row) => row.receipt_id === receiptId && row.status === "Failed",
  )!;

  assert.equal(failedReset.attempts, 1);
  assert.equal(failedReceipt.attempts, 1);
  resetMode = "accept";
  receiptMode = "accept";
  await boot({
    PASSWORD_RESET_DELIVERY_POLL_MS: "100",
    RECEIPT_DELIVERY_POLL_MS: "100",
    RECEIPT_DELIVERY_SENDER: "changed@example.invalid",
  });
  await eventually(
    "unattended recovery",
    async () =>
      (await resetRows()).find((row) => row.effect_id === reset.effect_id)?.status ===
        "Delivered" &&
      (await receiptRows())
        .filter((row) => row.receipt_id === receiptId)
        .every((row) => row.status === "Delivered"),
  );
  assert.deepEqual(await business(), before);

  for (const id of [reset.effect_id, failedReceipt.effect_id]) {
    const deliveries = attempts.filter((attempt) => attempt.id === id);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0]!.hash, deliveries[1]!.hash);
    assert.equal(deliveries[1]!.accepted, true);
  }

  assert.equal((await resetRows()).find((row) => row.effect_id === reset.effect_id)!.attempts, 2);
  assert.equal(
    (await receiptRows()).find((row) => row.effect_id === failedReceipt.effect_id)!.attempts,
    2,
  );
  checks.push(
    "reset and receipt: real request -> durable failure -> stopped native process -> unattended restart success; stable effect/payload, attempts=2, unchanged business facts",
  );
  await stop(current!);

  receiptMode = "failure";
  await boot({ RECEIPT_DELIVERY_MODE: "disabled", PASSWORD_RESET_DELIVERY_MODE: "disabled" });
  const poisonedReceipt = await receiptRequest();
  const otherReceipt = await receiptRequest();

  const poisonedEffect = (await receiptRows()).find(
    (row) => row.receipt_id === poisonedReceipt && row.status === "Failed",
  )!;

  poison.add(poisonedEffect.effect_id);
  const beforeDisabled = await receiptRows();
  await pause(300);
  assert.deepEqual(await receiptRows(), beforeDisabled);
  await stop(current!);
  await boot({
    BACKEND_INGRESS: "internal",
    OAUTH_INTERNAL_SOURCE_NETWORKS: '["127.0.0.1/32"]',
    PASSWORD_RESET_DELIVERY_POLL_MS: "100",
    RECEIPT_DELIVERY_POLL_MS: "100",
  });
  await pause(300);
  assert.deepEqual(await receiptRows(), beforeDisabled);
  await stop(current!);
  receiptMode = "accept";
  await boot({ RECEIPT_DELIVERY_POLL_MS: "100" });
  await eventually("unrelated receipt progresses past poison", async () =>
    (await receiptRows())
      .filter((row) => row.receipt_id === otherReceipt)
      .every((row) => row.status === "Delivered"),
  );
  assert.equal(
    (await receiptRows()).find((row) => row.effect_id === poisonedEffect.effect_id)!.status,
    "Failed",
  );
  poison.clear();
  await eventually("poison recovery", async () =>
    (await receiptRows())
      .filter((row) => row.receipt_id === poisonedReceipt)
      .every((row) => row.status === "Delivered"),
  );
  await stop(current!);
  checks.push(
    "disabled and internal workers do not claim; a failed receipt does not starve another receipt; predecessor order remains enforced",
  );

  // A changed reset payload must never reuse an idempotency key with a different body.
  resetMode = "failure";
  await boot();
  const drift = await resetRequest();
  await eventually(
    "reset drift baseline",
    async () =>
      (await resetRows()).find((row) => row.effect_id === drift.effect_id)?.status === "Failed",
  );
  await stop(current!);
  resetMode = "accept";
  await boot({ MAIL_SENDER: "changed@example.invalid", PASSWORD_RESET_DELIVERY_POLL_MS: "100" });
  await eventually(
    "reset drift quarantine",
    async () =>
      (await resetRows()).find((row) => row.effect_id === drift.effect_id)?.status ===
      "Quarantined",
  );
  assert.equal(attempts.filter((attempt) => attempt.id === drift.effect_id).length, 1);
  checks.push("reset payload drift quarantines without a second provider request");
  await stop(current!);

  resetMode = "hold";
  await boot({ PASSWORD_RESET_DELIVERY_POLL_MS: "100" });
  const interrupted = await resetRequest();
  await eventually("reset in flight", async () =>
    attempts.some((attempt) => attempt.id === interrupted.effect_id),
  );
  await stop(current!);

  const interruptedRow = (await resetRows()).find(
    (row) => row.effect_id === interrupted.effect_id,
  )!;

  assert.equal(interruptedRow.status, "Quarantined");
  assert.equal(interruptedRow.claim_id, null);
  assert.equal(interruptedRow.last_failure_code, "delivery-timeout");
  held.splice(0).forEach((release) => release());
  checks.push(
    "SIGTERM aborts reset provider delivery, joins fenced quarantine, and releases the native pool",
  );

  // Freeze an actual native owner, let its lease become stale, and start a replacement owner.
  resetMode = "hold";
  receiptMode = "hold";
  await boot({ PASSWORD_RESET_DELIVERY_POLL_MS: "100", RECEIPT_DELIVERY_POLL_MS: "100" });
  const staleReset = await resetRequest();
  const staleReceiptRequest = receiptRequest().catch(() => undefined);
  await eventually(
    "two held provider claims",
    async () =>
      attempts.some((attempt) => attempt.id === staleReset.effect_id) &&
      (await receiptRows()).some(
        (row) => row.status === "Processing" && row.delivery_envelope !== null,
      ),
  );
  const oldReset = (await resetRows()).find((row) => row.effect_id === staleReset.effect_id)!;

  const oldReceipt = (await receiptRows()).find(
    (row) => row.status === "Processing" && row.delivery_envelope !== null,
  )!;

  const frozen = current!;
  frozen.child.kill("SIGSTOP");
  await pause(61_000);
  resetMode = "accept";
  receiptMode = "accept";
  // A second main uses a separate listener, but the same durable queue and filesystem.
  const replacementPort = await port();
  current = start({
    ...env,
    BACKEND_PORT: String(replacementPort),
    PASSWORD_RESET_DELIVERY_POLL_MS: "100",
    RECEIPT_DELIVERY_POLL_MS: "100",
  });
  await eventually(
    "stale recovery",
    async () =>
      (await resetRows()).find((row) => row.effect_id === oldReset.effect_id)?.status ===
        "Quarantined" &&
      (await receiptRows()).find((row) => row.effect_id === oldReceipt.effect_id)?.status ===
        "Delivered",
  );

  const replacementReceipt = (await receiptRows()).find(
    (row) => row.effect_id === oldReceipt.effect_id,
  )!;

  assert.equal(replacementReceipt.attempts, oldReceipt.attempts + 1);
  assert.deepEqual(replacementReceipt.delivery_envelope, oldReceipt.delivery_envelope);
  assert.equal(attempts.filter((attempt) => attempt.id === oldReset.effect_id).length, 1);
  const factsAfterRecovery = await business();
  frozen.child.kill("SIGCONT");
  held.splice(0).forEach((release) => release());
  await pause(500);
  await stop(frozen);
  await staleReceiptRequest;
  assert.equal(
    (await resetRows()).find((row) => row.effect_id === oldReset.effect_id)!.status,
    "Quarantined",
  );
  assert.equal(
    (await receiptRows()).find((row) => row.effect_id === oldReceipt.effect_id)!.status,
    "Delivered",
  );
  assert.deepEqual(await business(), factsAfterRecovery);
  await stop(current!);
  checks.push(
    "stale reset owner cannot acknowledge quarantine; stale receipt owner cannot overwrite replacement delivery; receipt envelope and business facts remain unchanged",
  );

  // Fault injection affects availability, not durable business outcomes.
  for (const kind of ["reset", "receipt"] as const) {
    await boot({
      PASSWORD_RESET_DELIVERY_MODE: kind === "reset" ? "http" : "disabled",
      RECEIPT_DELIVERY_MODE: kind === "receipt" ? "http" : "disabled",
      PASSWORD_RESET_DELIVERY_POLL_MS: "100",
      RECEIPT_DELIVERY_POLL_MS: "100",
    });
    const table = kind === "reset" ? "auth.password_reset_email_outbox" : "economy_receipt_outbox";

    const renamed =
      kind === "reset" ? "password_reset_email_outbox_fault" : "economy_receipt_outbox_fault";

    await pool.query(`ALTER TABLE ${table} RENAME TO ${renamed}`);

    const code: number | null = await Promise.race([
      current!.exited,
      pause(10_000).then(() => {
        throw new Error("Root worker failure timeout");
      }),
    ]);

    assert.equal(code, 1);
    assert.ok(
      current!.logs
        .join("")
        .includes(
          kind === "reset"
            ? "password reset delivery worker failed"
            : "receipt delivery worker failed",
        ),
    );
    await pool.query(
      `ALTER TABLE ${kind === "reset" ? "auth." : ""}${renamed} RENAME TO ${table.split(".").at(-1)}`,
    );
    checks.push(`${kind}: root SQL failure stops actual native main with exit 1`);
  }

  const sessions = await pool.query(
    "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
  );

  assert.equal(sessions.rows[0].count, 0);
  checks.push("all native processes exited; no native PostgreSQL sessions remain");
} finally {
  held.splice(0).forEach((release) => release());

  for (const process of processes) {
    if (process.child.exitCode === null && process.child.signalCode === null) {
      process.child.kill("SIGCONT");
      process.child.kill("SIGKILL");
      await process.exited;
    }
  }

  await pool.end();
  provider.closeAllConnections();
  const providerClosed = Promise.withResolvers<void>();
  provider.close(() => providerClosed.resolve());
  await providerClosed.promise;

  if (postgresStarted) run("pg_ctl", ["-D", pgDirectory, "-m", "immediate", "-w", "stop"]);
  await rm(privateRoot, { recursive: true, force: true });
  await writeFile(
    join(artifacts, "evidence.json"),
    JSON.stringify(
      {
        revision,
        sourceTree,
        runtime: process.versions.bun,
        checks,
        cleanup: { privateResourcesRemoved: true, providersStopped: true, processesStopped: true },
        scope: "Synthetic local PostgreSQL and loopback provider only; no exactly-once claim",
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

assert.equal(checks.length, 8);

process.stdout.write(`PASS ${checks.length} recovery observations; sanitized evidence retained\n`);
