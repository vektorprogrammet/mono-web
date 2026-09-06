/** 0100 owned synthetic PostgreSQL / real Better Auth / recovery / restore journey. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { Effect, Redacted } from "effect";
import { databaseHealth } from "@vektorprogrammet/domain/database";
import { DatabaseLive } from "../src/layers.js";
import { makeAuthEngineOptions, makeAuthPool, type AuthEngineConfig } from "../src/auth-engine.js";
import { makePasswordRecovery, drainPasswordResetMail } from "../src/password-recovery.js";
import { identityRequestContext } from "../../../apps/backend/src/session-security.js";
import {
  makeHttpPasswordResetDelivery,
  passwordResetDeliveryConfig,
} from "../../../apps/backend/src/password-recovery/http-delivery.js";
import { importIdentityCohort, IdentityCohortFailure } from "../src/identity-cohort.js";
import {
  nativeAndLegacyPasswordCodec,
  isNativePasswordHash,
  verifyNativeOrLegacyPassword,
} from "../src/password-codec.js";
declare const Bun: {
  version: string;
  serve(options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Promise<Response>;
  }): { stop(force?: boolean): void | Promise<void> };
};
const root = resolve(import.meta.dirname, "../../..");
const command = (name: string, args: string[]) =>
  execFileSync(name, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
const revision = command("git", ["rev-parse", "HEAD"]).trim();
assert.equal(command("git", ["status", "--porcelain"]).trim(), "", "clean source required");
for (const key of [
  "PASSWORD_RESET_DELIVERY_URL",
  "PASSWORD_RESET_DELIVERY_TOKEN",
  "CONTACT_DELIVERY_URL",
  "RECEIPT_DELIVERY_URL",
  "IDENTITY_COHORT_PG_URL",
])
  assert.ok(!process.env[key], "ambient external configuration prohibited");
const artifacts = await mkdtemp(join(tmpdir(), "vektor-cohort-0100-"));
const pgdata = join(artifacts, "postgres"),
  backup = join(artifacts, "cohort.dump"),
  inputFile = join(artifacts, "source.json");
const children: ChildProcess[] = [];
let pool: Pool | undefined,
  authPool: Pool | undefined,
  server: ReturnType<typeof Bun.serve> | undefined;
let sink: ReturnType<typeof createHttpServer> | undefined;
const secrets: string[] = [];
const safe = (value: string) =>
  secrets.reduce((s, v) => (v ? s.replaceAll(v, "[redacted]") : s), value);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
};
const wait = async (check: () => Promise<void>) => {
  for (let i = 0; i < 100; i++) {
    try {
      await check();
      return;
    } catch {
      await pause(100);
    }
  }
  throw new Error("owned service readiness timeout");
};
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned process cleanup timeout")), 15000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
};
let evidence: Record<string, unknown> | undefined;
try {
  const port = await freePort();
  command("initdb", [
    "-D",
    pgdata,
    "-A",
    "trust",
    "-U",
    "postgres",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  const postgres = spawn(
    "postgres",
    ["-D", pgdata, "-p", String(port), "-h", "127.0.0.1", "-k", artifacts],
    { stdio: "ignore" },
  );
  children.push(postgres);
  pool = new Pool({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres` });
  await wait(async () => {
    await pool!.query("SELECT 1");
  });
  await pool.query("CREATE DATABASE identity_cohort_rehearsal");
  await pool.end();
  const databaseUrl = `postgres://postgres@127.0.0.1:${port}/identity_cohort_rehearsal`;
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await Effect.runPromise(
    databaseHealth.pipe(
      Effect.provide(DatabaseLive({ url: Redacted.make(databaseUrl), maxConnections: 1 })),
    ),
  );
  const php = process.env.IDENTITY_COHORT_PHP ?? "php";
  const values = [
    "Synthetic-Å-0100-password",
    "a".repeat(72) + "legacy-tail",
    "a".repeat(71) + "é-legacy-tail",
  ];
  const hashes = values.map((p) =>
    command(php, ["-r", "echo password_hash($argv[1],PASSWORD_BCRYPT,['cost'=>12]);", p]),
  );
  secrets.push(...values, ...hashes);
  for (let i = 0; i < values.length; i++) {
    assert.ok(
      await verifyNativeOrLegacyPassword({ hash: hashes[i]!, password: values[i]! }),
      "PHP/bcrypt cross-runtime verification",
    );
    assert.equal(
      await verifyNativeOrLegacyPassword({ hash: hashes[i]!, password: "wrong-password" }),
      false,
    );
  }
  assert.equal(
    await verifyNativeOrLegacyPassword({ hash: hashes[0]!, password: values[0]! + "\0tail" }),
    false,
  );
  assert.equal(
    await verifyNativeOrLegacyPassword({ hash: hashes[0]!, password: values[0]!.normalize("NFD") }),
    false,
    "legacy bytes must not undergo NFKC normalization",
  );
  type Row = {
    sourceUserId: string;
    active: boolean;
    email: string;
    passwordHash: string | null;
    username?: string;
  };
  const occurrences: Array<{ occurrenceId: string; row: unknown }> = [];
  const mappings: Array<{
    sourceUserId: string;
    personId: string;
    emailOwnership: { email: string; attestedBy: string; evidenceRef: string };
  }> = [];
  const add = (id: string, overrides: Partial<Row> = {}, mapping = true) => {
    const row: Row = {
      sourceUserId: id,
      active: true,
      email: `cohort-${id}@example.invalid`,
      passwordHash: hashes[0]!,
      username: `legacy-${id}`,
      ...overrides,
    };
    occurrences.push({ occurrenceId: `occ-${id}`, row });
    if (mapping)
      mappings.push({
        sourceUserId: id,
        personId: `person-${id}`,
        emailOwnership: {
          email: row.email,
          attestedBy: "synthetic-operator",
          evidenceRef: `attestation-${id}`,
        },
      });
    return row;
  };
  for (let i = 0; i < 3; i++) add(`accepted-${i}`, { passwordHash: hashes[i]! });
  add("inactive", { active: false });
  add("missing-password", { passwordHash: null });
  add("unsupported", { passwordHash: hashes[0]!.replace("$2y$", "$2b$") });
  add("cost", { passwordHash: hashes[0]!.replace("$12$", "$04$") });
  add("malformed", { passwordHash: "bad" });
  add("no-map", {}, false);
  add("ambiguous");
  mappings.push({ ...mappings.at(-1)! });
  add("unattested");
  mappings.at(-1)!.emailOwnership.email = "someone-else@example.invalid";
  const duplicate = add("duplicate-source");
  occurrences.push({ occurrenceId: "occ-duplicate-source-second", row: { ...duplicate } });
  add("duplicate-email-a", { email: "shared@example.invalid" });
  add("duplicate-email-b", { email: "SHARED@example.invalid" });
  add("duplicate-target-a");
  add("duplicate-target-b");
  mappings.at(-1)!.personId = "person-duplicate-target-a";
  add("person-missing");
  add("target-conflict");
  add("email-conflict");
  occurrences.push({
    occurrenceId: "occ-invalid",
    row: { sourceUserId: "invalid", unexpected: true },
  });
  const snapshot = {
    sourceRepository: "synthetic-legacy",
    sourceRevision: "synthetic-source-0100",
    snapshotId: "cohort-0100",
    transformationRevision: "0100-v1",
    synthetic: true,
    occurrences,
    mappings,
  };
  for (const personId of new Set(
    mappings.map((m) => m.personId).filter((p) => p !== "person-person-missing"),
  ))
    await pool.query(
      "INSERT INTO person_profiles(person_id,first_name,last_name) VALUES($1,'Synthetic','Cohort')",
      [personId],
    );
  await pool.query(
    "INSERT INTO person_profiles(person_id,first_name,last_name) VALUES('existing-email-owner','Synthetic','Existing')",
  );
  await pool.query(
    "INSERT INTO auth.\"user\"(id,name,email,\"emailVerified\") VALUES('person-target-conflict','Existing','target-existing@example.invalid',false),('existing-email-owner','Existing','cohort-email-conflict@example.invalid',false)",
  );
  const profilesBefore = digest(
    (await pool.query("SELECT * FROM person_profiles ORDER BY person_id")).rows,
  );
  const facts = async () =>
    digest(
      (
        await pool!.query(
          `SELECT jsonb_build_object('users',(SELECT jsonb_agg(u ORDER BY id) FROM auth."user" u),'accounts',(SELECT jsonb_agg(a ORDER BY id) FROM auth."account" a),'snapshots',(SELECT jsonb_agg(s ORDER BY snapshot_key) FROM auth.credential_cohort_snapshots s),'occurrences',(SELECT jsonb_agg(o ORDER BY snapshot_key,occurrence_id) FROM auth.credential_cohort_occurrences o),'imports',(SELECT jsonb_agg(i ORDER BY source_repository,source_user_id) FROM auth.credential_cohort_imports i)) AS facts`,
        )
      ).rows,
    );
  const report = await importIdentityCohort(pool, snapshot);
  assert.equal(report.accepted, 3);
  assert.equal(report.input, occurrences.length);
  assert.equal(report.quarantined, occurrences.length - 3);
  assert.deepEqual(
    (await pool.query('SELECT "userId" FROM auth."account" ORDER BY "userId"')).rows.map(
      (r) => r.userId,
    ),
    ["person-accepted-0", "person-accepted-1", "person-accepted-2"],
    "quarantined occurrences create no credential",
  );
  assert.equal(
    digest((await pool.query("SELECT * FROM person_profiles ORDER BY person_id")).rows),
    profilesBefore,
  );
  const initialFacts = await facts();
  assert.deepEqual(await importIdentityCohort(pool, snapshot), report);
  assert.equal(await facts(), initialFacts);
  const concurrent = await Promise.all([
    importIdentityCohort(pool, snapshot),
    importIdentityCohort(pool, snapshot),
  ]);
  assert.deepEqual(concurrent, [report, report]);
  assert.equal(await facts(), initialFacts);
  await assert.rejects(
    importIdentityCohort(pool, { ...snapshot, sourceRevision: "changed" }),
    (e) => e instanceof IdentityCohortFailure && e.code === "SnapshotConflict",
  );
  const changed = structuredClone(snapshot);
  changed.snapshotId = "changed-source";
  (changed.occurrences[0]!.row as Row).active = false;
  await assert.rejects(
    importIdentityCohort(pool, changed),
    (e) => e instanceof IdentityCohortFailure && e.code === "SourceIdentityConflict",
  );
  assert.equal(await facts(), initialFacts);
  await pool.query(
    "INSERT INTO person_profiles(person_id,first_name,last_name) VALUES('person-failure','Synthetic','Failure')",
  );
  const failedSnapshot = {
    ...snapshot,
    snapshotId: "failure",
    occurrences: [
      {
        occurrenceId: "failure",
        row: {
          sourceUserId: "failure",
          active: true,
          email: "failure@example.invalid",
          passwordHash: hashes[0]!,
        },
      },
    ],
    mappings: [
      {
        sourceUserId: "failure",
        personId: "person-failure",
        emailOwnership: {
          email: "failure@example.invalid",
          attestedBy: "synthetic-operator",
          evidenceRef: "failure",
        },
      },
    ],
  };
  await pool.query(
    "CREATE FUNCTION auth.fail_cohort_0100() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic failure'; END $$; CREATE TRIGGER fail_cohort_0100 BEFORE INSERT ON auth.credential_cohort_imports FOR EACH ROW EXECUTE FUNCTION auth.fail_cohort_0100()",
  );
  await assert.rejects(importIdentityCohort(pool, failedSnapshot));
  assert.equal(
    (await pool.query("SELECT 1 FROM auth.\"user\" WHERE id='person-failure'")).rowCount,
    0,
  );
  assert.equal(await facts(), initialFacts);
  await pool.query(
    "DROP TRIGGER fail_cohort_0100 ON auth.credential_cohort_imports; DROP FUNCTION auth.fail_cohort_0100()",
  );
  await assert.rejects(
    pool.query("UPDATE auth.credential_cohort_imports SET source_digest=repeat('f',64)"),
  );
  await writeFile(inputFile, JSON.stringify(snapshot), { mode: 0o600 });
  const cli = spawn("bun", ["run", "packages/database/runtime/identity-cohort-main.ts"], {
    cwd: root,
    env: {
      ...process.env,
      IDENTITY_COHORT_MODE: "synthetic",
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      IDENTITY_COHORT_PG_URL: databaseUrl,
      IDENTITY_COHORT_INPUT: inputFile,
    },
    stdio: "ignore",
  });
  children.push(cli);
  assert.equal(await new Promise<number | null>((r) => cli.once("exit", r)), 0);
  assert.equal(await facts(), initialFacts);
  const authPort = await freePort(),
    origin = `http://127.0.0.1:${authPort}`;
  const config: AuthEngineConfig = {
    postgresUrl: databaseUrl,
    secret: randomBytes(32).toString("hex"),
    secureCookies: false,
    trustedOrigins: ["http://127.0.0.1:5174"],
    oauth: {
      canonicalOrigin: origin,
      dashboardOrigin: "http://127.0.0.1:5174",
      nativeApiResource: "urn:vektorprogrammet:native-api",
    },
  };
  secrets.push(config.secret);
  const startEngine = (selected: AuthEngineConfig) => {
    authPool = makeAuthPool(selected);
    const recovery = makePasswordRecovery(authPool, selected);
    const base = makeAuthEngineOptions(selected, authPool, recovery);
    const engine = betterAuth({
      ...base,
      emailAndPassword: { ...base.emailAndPassword, password: nativeAndLegacyPasswordCodec },
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: authPort,
      fetch: (request) =>
        recovery.handler(engine.handler, request, identityRequestContext(request)),
    });
  };
  startEngine(config);
  const post = (path: string, body: unknown) =>
    fetch(origin + path, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:5174", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const login = async (email: string, password: string) =>
    post("/api/auth/sign-in/email", { email, password });
  let oldCookie = "";
  for (let i = 0; i < 3; i++) {
    const response = await login(`cohort-accepted-${i}@example.invalid`, values[i]!);
    assert.equal(response.status, 200, "accepted cohort sign-in");
    if (i === 0) {
      oldCookie = response.headers
        .getSetCookie()
        .map((s) => s.split(";")[0])
        .join("; ");
      secrets.push(oldCookie);
    }
  }
  assert.equal((await login("cohort-accepted-0@example.invalid", "wrong-password")).status, 401);
  assert.equal((await login("cohort-inactive@example.invalid", values[0]!)).status, 401);
  assert.equal(
    (await login("legacy-accepted-0", values[0]!)).status,
    400,
    "username alias remains unsupported",
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM auth."user" WHERE id LIKE \'person-accepted-%\' AND "emailVerified"',
      )
    ).rows[0].n,
    0,
    "attestation must not invent verification flag",
  );
  const deliveryToken = randomBytes(24).toString("hex");
  secrets.push(deliveryToken);
  let deliveredUrl = "",
    deliveryAttempts = 0;
  sink = createHttpServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${deliveryToken}`) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const value = JSON.parse(body);
    deliveryAttempts++;
    assert.equal(value.recipientEmail, "cohort-accepted-0@example.invalid");
    deliveredUrl = value.resetUrl;
    secrets.push(deliveredUrl);
    res.writeHead(202).end();
  });
  await new Promise<void>((r) => sink!.listen(0, "127.0.0.1", r));
  const sinkPort = (sink.address() as { port: number }).port;
  const requestReset = await post("/api/auth/request-password-reset", {
    email: "cohort-accepted-0@example.invalid",
    redirectTo: "http://127.0.0.1:5174/tilbakestill-passord",
  });
  assert.equal(requestReset.status, 200, "migrated account reset request");
  const delivery = makeHttpPasswordResetDelivery(
    passwordResetDeliveryConfig({
      PASSWORD_RESET_DELIVERY_URL: `http://127.0.0.1:${sinkPort}`,
      PASSWORD_RESET_DELIVERY_TOKEN: deliveryToken,
      PASSWORD_RESET_DELIVERY_TIMEOUT_MS: "1000",
      PASSWORD_RESET_DELIVERY_SENDER: "recovery@example.invalid",
    }),
  );
  assert.equal(await drainPasswordResetMail(authPool!, config, delivery), "Delivered");
  assert.equal(deliveryAttempts, 1);
  const redirect = await fetch(deliveredUrl, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  const resetToken = new URL(redirect.headers.get("location")!).searchParams.get("token")!;
  secrets.push(resetToken);
  const newPassword = "Native-Cohort-Reset-0100-Å";
  secrets.push(newPassword);
  assert.equal(
    (await post("/api/auth/reset-password", { token: resetToken, newPassword })).status,
    200,
  );
  assert.equal((await login("cohort-accepted-0@example.invalid", values[0]!)).status, 401);
  assert.equal((await login("cohort-accepted-0@example.invalid", newPassword)).status, 200);
  const oldSession = await fetch(origin + "/api/auth/get-session", {
    headers: { cookie: oldCookie },
  });
  assert.equal(await oldSession.json(), null, "old sessions revoked");
  const stored = (
    await pool.query('SELECT password FROM auth."account" WHERE "userId"=\'person-accepted-0\'')
  ).rows[0].password as string;
  secrets.push(stored);
  assert.ok(isNativePasswordHash(stored));
  await importIdentityCohort(pool, snapshot);
  assert.equal(
    (await pool.query('SELECT password FROM auth."account" WHERE "userId"=\'person-accepted-0\''))
      .rows[0].password,
    stored,
    "replay must not undo reset",
  );
  await server!.stop(true);
  server = undefined;
  await authPool!.end();
  authPool = undefined;
  command("pg_dump", ["--format=custom", "--file", backup, databaseUrl]);
  await chmod(backup, 0o600);
  const backupDigest = createHash("sha256")
    .update(await readFile(backup))
    .digest("hex");
  await pool.query("CREATE DATABASE identity_cohort_restored");
  const restoredUrl = `postgres://postgres@127.0.0.1:${port}/identity_cohort_restored`;
  command("pg_restore", ["--exit-on-error", "--dbname", restoredUrl, backup]);
  startEngine({ ...config, postgresUrl: restoredUrl });
  assert.equal(
    (await login("cohort-accepted-0@example.invalid", newPassword)).status,
    200,
    "actual restored native hash login",
  );
  assert.equal(
    (await login("cohort-accepted-1@example.invalid", values[1]!)).status,
    200,
    "actual restored legacy hash login",
  );
  evidence = {
    specId: "0100",
    revision,
    report,
    passed: true,
    compatibility: {
      phpVersion: command(php, ["-r", "echo PHP_VERSION;"]),
      bunVersion: Bun.version,
      cost12: true,
      byte72Ascii: true,
      byte72Multibyte: true,
      legacyNoNormalization: true,
      legacyNulRejected: true,
    },
    replay: {
      exact: true,
      concurrent: true,
      changedSnapshotRejected: true,
      changedInactiveSourceRejected: true,
      resetPreserved: true,
    },
    atomicFailureNoPartialIdentity: true,
    immutableProvenance: true,
    profilesPreserved: true,
    emailVerificationNotInvented: true,
    disabledLoginDenied: true,
    legacyAliasUnsupported: true,
    recovery: {
      acknowledgedAttempts: deliveryAttempts,
      oldPasswordDenied: true,
      newNativePasswordAccepted: true,
      oldSessionRevoked: true,
    },
    restore: { nonemptyBackupSha256: backupDigest, nativeHashLogin: true, legacyHashLogin: true },
    scope:
      "Synthetic mapped/attested cohort; actual BetterAuth HTTP and canonical recovery wrapper/ACK adapter; no provider, production, real attestation or full legacy cohort claim",
  };
} catch (cause) {
  await writeFile(
    join(artifacts, "failure.json"),
    JSON.stringify(
      { revision, error: safe(cause instanceof Error ? cause.message : String(cause)) },
      null,
      2,
    ),
  );
  throw new Error(`Synthetic cohort failed; safe evidence: ${artifacts}/failure.json`);
} finally {
  await server?.stop(true);
  await authPool?.end();
  if (sink) {
    sink.closeAllConnections();
    await new Promise<void>((r) => sink!.close(() => r()));
  }
  await pool?.end();
  for (const child of children.toReversed()) await stop(child);
  await rm(pgdata, { recursive: true, force: true });
  await rm(backup, { force: true });
  await rm(inputFile, { force: true });
}
const output = JSON.stringify(
  {
    ...evidence,
    cleanup: "owned processes/connections stopped; credential input, dump and PostgreSQL removed",
  },
  null,
  2,
);
for (const secret of secrets)
  if (secret) assert.ok(!output.includes(secret), "private material prohibited in evidence");
await writeFile(join(artifacts, "evidence.json"), output);
console.log(`0100 passed: ${artifacts}/evidence.json`);
