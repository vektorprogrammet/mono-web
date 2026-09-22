/** 0107 owned Person-to-Account reconciliation / Better Auth / recovery / restore journey. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { Pool } from "pg";
import { Effect, Redacted } from "effect";
import { databaseHealth } from "@vektorprogrammet/database";
import { DatabaseLive } from "../src/layers.js";
import { makeAuthEngine, makeAuthPool, type AuthEngineConfig } from "../src/auth-engine.js";
import { makePasswordRecovery, drainPasswordResetMail } from "../src/password-recovery.js";
import { identityRequestContext } from "../../../apps/backend/src/session-security.js";
import {
  makeHttpPasswordResetDelivery,
  passwordResetDeliveryConfig,
} from "../../../apps/backend/src/password-recovery/http-delivery.js";
import { importIdentityCohort, IdentityCohortFailure } from "../src/identity-cohort.js";
import { importPersonCohort } from "../src/person-cohort.js";
import { isNativePasswordHash, verifyNativeOrLegacyPassword } from "../src/password-codec.js";
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
const artifacts = await mkdtemp(join(tmpdir(), "vektor-account-cohort-0107-"));
const pgdata = join(artifacts, "postgres"),
  backup = join(artifacts, "cohort.dump"),
  inputFile = join(artifacts, "source.json");
const children: ChildProcess[] = [];
let pool: Pool | undefined,
  authPool: Pool | undefined,
  server: ReturnType<typeof Bun.serve> | undefined;
let sink: ReturnType<typeof createHttpServer> | undefined;
const secrets: string[] = [];
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
    "Synthetic-Å-0107-password",
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
    companyEmail?: string;
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
      companyEmail: `${id}@vektorprogrammet.invalid`,
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
  const acceptedRows = values.map((_, i) => add(`accepted-${i}`, { passwordHash: hashes[i]! }));
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
  const targetConflictRow = add("target-conflict");
  const emailConflictRow = add("email-conflict");
  occurrences.push({
    occurrenceId: "occ-invalid",
    row: { sourceUserId: "invalid", unexpected: true },
  });
  const snapshot = {
    sourceRepository: "synthetic-legacy",
    sourceRevision: "synthetic-source-0107",
    snapshotId: "cohort-0107",
    transformationRevision: "0107-v1",
    synthetic: true,
    occurrences,
    mappings,
  };
  const reconcilePerson = async (
    source: Row,
    mode: "create" | "link" = "create",
    personId = `person-${source.sourceUserId}`,
  ) => {
    const personMapping =
      mode === "create"
        ? {
            _tag: "CreatePerson" as const,
            sourceUserId: source.sourceUserId,
            personId,
            emailOwnership: {
              email: source.email,
              attestedBy: "synthetic-operator",
              evidenceRef: `person-attestation-${source.sourceUserId}`,
            },
          }
        : {
            _tag: "LinkExistingPerson" as const,
            sourceUserId: source.sourceUserId,
            personId,
            emailOwnership: {
              email: source.email,
              attestedBy: "synthetic-operator",
              evidenceRef: `person-attestation-${source.sourceUserId}`,
            },
            expectedNameRevision: 0,
            expectedContactRevision: 0,
          };
    const result = await importPersonCohort(pool!, {
      sourceRepository: snapshot.sourceRepository,
      sourceRevision: `person-source-${source.sourceUserId}`,
      snapshotId: `person-${source.sourceUserId}`,
      transformationRevision: "0107-v1",
      synthetic: true,
      occurrences: [
        {
          occurrenceId: `person-${source.sourceUserId}`,
          row: {
            sourceUserId: source.sourceUserId,
            active: true,
            firstName: "Synthetic",
            lastName: "Cohort",
            email: source.email,
            phone: "+47 999 00 000",
          },
        },
      ],
      mappings: [personMapping],
    });
    assert.equal(result.accepted, 1);
  };
  await pool.query(
    "INSERT INTO person_profiles(person_id,first_name,last_name) VALUES('person-accepted-2','Synthetic','Cohort'); INSERT INTO person_contact_profiles(person_id,email,phone) VALUES('person-accepted-2','cohort-accepted-2@example.invalid','+47 999 00 000')",
  );
  for (const [index, source] of acceptedRows.entries())
    await reconcilePerson(source, index === 2 ? "link" : "create");
  for (const source of [targetConflictRow, emailConflictRow]) await reconcilePerson(source);
  await pool.query(
    "INSERT INTO person_profiles(person_id,first_name,last_name) VALUES('person-person-missing','Synthetic','ProfileOnly'),('existing-email-owner','Synthetic','Existing')",
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
    report.occurrences.find((entry) => entry.occurrenceId === "occ-person-missing"),
    {
      occurrenceId: "occ-person-missing",
      disposition: "Quarantined",
      reason: "PersonReconciliationMissing",
    },
  );
  assert.equal(
    report.occurrences.find((entry) => entry.occurrenceId === "occ-target-conflict")?.reason,
    "TargetConflict",
  );
  assert.equal(
    report.occurrences.find((entry) => entry.occurrenceId === "occ-email-conflict")?.reason,
    "EmailConflict",
  );
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
  const failedRow: Row = {
    sourceUserId: "failure",
    active: true,
    email: "failure@example.invalid",
    passwordHash: hashes[0]!,
  };
  await reconcilePerson(failedRow);
  const failedSnapshot = {
    ...snapshot,
    snapshotId: "failure",
    occurrences: [
      {
        occurrenceId: "failure",
        row: failedRow,
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
    "CREATE FUNCTION auth.fail_cohort_0107() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic failure'; END $$; CREATE TRIGGER fail_cohort_0107 BEFORE INSERT ON auth.credential_cohort_imports FOR EACH ROW EXECUTE FUNCTION auth.fail_cohort_0107()",
  );
  await assert.rejects(importIdentityCohort(pool, failedSnapshot));
  assert.equal(
    (await pool.query("SELECT 1 FROM auth.\"user\" WHERE id='person-failure'")).rowCount,
    0,
  );
  assert.equal(await facts(), initialFacts);
  await pool.query(
    "DROP TRIGGER fail_cohort_0107 ON auth.credential_cohort_imports; DROP FUNCTION auth.fail_cohort_0107()",
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
  const concurrentRow: Row = {
    sourceUserId: "concurrent-initial",
    active: true,
    email: "concurrent-initial@example.invalid",
    passwordHash: hashes[0]!,
    username: "legacy-concurrent-initial",
    companyEmail: "concurrent-initial@vektorprogrammet.invalid",
  };
  await reconcilePerson(concurrentRow);
  const concurrentSnapshot = {
    ...snapshot,
    sourceRevision: "synthetic-source-0107-concurrent",
    snapshotId: "cohort-0107-concurrent",
    occurrences: [{ occurrenceId: "concurrent-initial", row: concurrentRow }],
    mappings: [
      {
        sourceUserId: concurrentRow.sourceUserId,
        personId: "person-concurrent-initial",
        emailOwnership: {
          email: concurrentRow.email,
          attestedBy: "synthetic-operator",
          evidenceRef: "concurrent-initial",
        },
      },
    ],
  };
  const concurrentInitial = await Promise.all([
    importIdentityCohort(pool, concurrentSnapshot),
    importIdentityCohort(pool, concurrentSnapshot),
  ]);
  assert.deepEqual(concurrentInitial, [concurrentInitial[0], concurrentInitial[0]]);
  assert.equal(concurrentInitial[0]!.accepted, 1);
  assert.deepEqual(
    (
      await pool.query(
        `SELECT
           (SELECT count(*)::int FROM auth."user" WHERE id='person-concurrent-initial') AS users,
           (SELECT count(*)::int FROM auth."account" WHERE "userId"='person-concurrent-initial') AS accounts,
           (SELECT count(*)::int FROM auth.credential_cohort_imports WHERE source_user_id='concurrent-initial') AS imports`,
      )
    ).rows[0],
    { users: 1, accounts: 1, imports: 1 },
  );
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
    const engine = makeAuthEngine(selected, authPool, recovery);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: authPort,
      fetch: (request) =>
        recovery.handler(engine.handler, request, identityRequestContext(request)),
    });
  };
  startEngine(config);
  const post = async (path: string, body: unknown): Promise<Response> => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(origin + path, {
        method: "POST",
        headers: { origin: "http://127.0.0.1:5174", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status !== 429) return response;
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000 + 100, 61_000)
          : 10_100;
      await response.body?.cancel();
      await pause(waitMs);
    }
    throw new Error("bounded identity rate-limit retry exhausted");
  };
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
  assert.equal(
    (await pool.query('SELECT name FROM auth."user" WHERE id=$1', ["person-accepted-0"])).rows[0]
      ?.name,
    "Synthetic Cohort",
    "Account name is projected from the reconciled Person profile",
  );
  assert.equal((await login("cohort-accepted-0@example.invalid", "wrong-password")).status, 401);
  assert.equal((await login("cohort-inactive@example.invalid", values[0]!)).status, 401);
  assert.equal(
    (await login("legacy-accepted-0", values[0]!)).status,
    400,
    "username alias remains unsupported",
  );
  assert.equal(
    (await login("accepted-0@vektorprogrammet.invalid", values[0]!)).status,
    401,
    "company-email alias remains unsupported",
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
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      deliveryAttempts++;
      if (
        value.recipientEmail !== "cohort-accepted-0@example.invalid" ||
        typeof value.resetUrl !== "string"
      ) {
        res.writeHead(422).end();
        return;
      }
      deliveredUrl = value.resetUrl;
      secrets.push(deliveredUrl);
      res.writeHead(202).end();
    } catch {
      res.writeHead(400).end();
    }
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
  const newPassword = "Native-Account-Cohort-Reset-0107-Å";
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
    specId: "0107",
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
    existingPersonLinked: true,
    replay: {
      exact: true,
      concurrent: true,
      concurrentInitial: true,
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
    personReconciliationRequired: true,
    reconciledProfileNameUsed: true,
    recovery: {
      acknowledgedAttempts: deliveryAttempts,
      oldPasswordDenied: true,
      newNativePasswordAccepted: true,
      oldSessionRevoked: true,
    },
    restore: { nonemptyBackupSha256: backupDigest, nativeHashLogin: true, legacyHashLogin: true },
    scope:
      "Synthetic Person-reconciled/attested cohort; actual BetterAuth HTTP and canonical recovery wrapper/ACK adapter; legacy aliases quarantined; no real source, provider, production, real attestation or full legacy cohort claim",
  };
} catch (cause) {
  await writeFile(
    join(artifacts, "failure.json"),
    JSON.stringify(
      {
        revision,
        error: cause instanceof IdentityCohortFailure ? cause.code : "RehearsalFailed",
        location:
          cause instanceof Error
            ? cause.stack
                ?.split("\n")
                .filter((line) => /at .*\.ts:\d/.test(line))
                .slice(0, 3)
            : [],
      },
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
console.log(`0107 passed: ${artifacts}/evidence.json`);
