/** 0095: owned local PostgreSQL/auth/SDK/files import and restore rehearsal. */
import assert from "node:assert/strict";
import { observeReceiptDelivery } from "./receipt-delivery-observation.js";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  cp,
  symlink,
  chmod,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Effect, Redacted } from "effect";
import { DatabaseLive } from "../../../packages/database/src/layers.js";
import { Database, databaseHealth } from "../../../packages/domain/src/database/service.js";
import {
  storeReceiptImportResult,
  reconcileReceiptImport,
} from "../../../packages/domain/src/receipt/postgres.js";
import {
  ReceiptAuxiliaryEffects,
  ReceiptAuxiliaryEffectConflict,
} from "../../../packages/domain/src/receipt/auxiliary-service.js";
import { ReceiptFileService } from "../../../packages/domain/src/receipt/file-service.js";
import { deliverNextReceiptOutbox } from "../../../packages/domain/src/receipt/outbox.js";
import type { ReceiptImportResult } from "../../../packages/domain/src/receipt/import.js";
import { ReceiptId } from "../../../packages/domain/src/receipt/schema.js";
import { createPromiseClient } from "../../../packages/sdk/src/promise.js";
import { canonicalJson } from "../../../packages/domain/src/tutor/evidence.js";
import { makeReceiptFileStore } from "../../../apps/backend/src/receipt/filesystem.js";
import {
  decodeSnapshot,
  digest,
  rowDigest,
  prepareReceiptSnapshot,
} from "../../../apps/backend/src/receipt/import-snapshot.js";
const requireDatabase = createRequire(
  new URL("../../../packages/database/package.json", import.meta.url),
);
const { Pool } = requireDatabase("pg") as typeof import("pg");
const root = resolve(import.meta.dirname, "../../..");
const command = (name: string, args: string[], env = process.env) =>
  execFileSync(name, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const revision = command("git", ["rev-parse", "HEAD"]).trim();
assert.equal(
  command("git", ["status", "--porcelain"]).trim(),
  "",
  "committed clean artifact required",
);
for (const key of [
  "RECEIPT_DELIVERY_URL",
  "RECEIPT_DELIVERY_TOKEN",
  "CONTACT_DELIVERY_URL",
  "CONTACT_DELIVERY_TOKEN",
  "PUBLIC_APPLICATION_EFFECT_ENDPOINT",
  "PUBLIC_APPLICATION_EFFECT_TOKEN",
])
  assert.ok(!process.env[key], `unset provider configuration: ${key}`);
const artifacts = await mkdtemp(join(tmpdir(), "vektor-receipt-0095-"));
const pgdata = join(artifacts, "postgres");
const storage = join(artifacts, "storage");
const fixtureRoot = join(artifacts, "source");
await mkdir(fixtureRoot);
await mkdir(storage);
const children: ChildProcess[] = [];
const logs: string[] = [];
const secretValues: string[] = [];
const safe = (value: string) =>
  secretValues.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
};
const start = (name: string, args: string[], env: NodeJS.ProcessEnv) => {
  const child = spawn(name, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (b) => {
    logs.push(String(b));
    if (logs.length > 30) logs.shift();
  });
  return child;
};
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    const bound = setTimeout(() => reject(new Error("owned child did not exit")), 15000);
    child.once("exit", () => {
      clearTimeout(timeout);
      clearTimeout(bound);
      resolve();
    });
    child.kill("SIGTERM");
  });
};
const wait = async (check: () => Promise<unknown>) => {
  for (let n = 0; n < 150; n++) {
    try {
      await check();
      return;
    } catch {
      await pause(100);
    }
  }
  throw new Error("owned runtime startup timed out");
};
let pool: InstanceType<typeof Pool> | undefined;
let backend: ChildProcess | undefined;
let evidence: unknown;
let cleanupOkay = false;
try {
  const pgPort = await freePort(),
    backendPort = await freePort();
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
  start(
    "postgres",
    ["-D", pgdata, "-p", String(pgPort), "-h", "127.0.0.1", "-k", artifacts],
    process.env,
  );
  const baseUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
  pool = new Pool({ connectionString: baseUrl });
  await wait(() => pool!.query("SELECT 1"));
  await pool.query("CREATE DATABASE receipt_0095");
  const pgUrl = `postgres://postgres@127.0.0.1:${pgPort}/receipt_0095`;
  await pool.end();
  pool = new Pool({ connectionString: pgUrl });
  const databaseLayer = DatabaseLive({ url: Redacted.make(pgUrl), maxConnections: 2 });
  const run = <A, E>(program: Effect.Effect<A, E, Database>) =>
    Effect.runPromise(program.pipe(Effect.provide(databaseLayer)));
  await run(databaseHealth);
  console.log("0095 database migrated");
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const password = randomBytes(24).toString("hex");
  secretValues.push(password);
  const persons = [
    {
      personId: "receipt-owner-0095",
      firstName: "Synthetic",
      lastName: "Owner",
      email: "owner0095@example.invalid",
      password,
    },
    {
      personId: "receipt-foreign-0095",
      firstName: "Synthetic",
      lastName: "Other",
      email: "foreign0095@example.invalid",
      password,
    },
  ];
  const env = {
    ...process.env,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
    BACKEND_PG_URL: pgUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    NATIVE_IDENTITY_DEPLOYMENT: "local",
    NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:5174"]),
    OAUTH_CANONICAL_ORIGIN: backendOrigin,
    OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:5174",
    OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
    RECEIPT_STAGING_ROOT: join(storage, "staging"),
    RECEIPT_COMMITTED_ROOT: join(storage, "committed"),
  };
  secretValues.push(env.BETTER_AUTH_SECRET);
  command("bun", ["run", "packages/database/runtime/identity-seed-main.ts"], {
    ...env,
    IDENTITY_SEED_PG_URL: pgUrl,
    IDENTITY_SEED_PERSONS: JSON.stringify(persons),
  });
  for (const person of persons) {
    const result: import("pg").QueryResult<{
      id: string;
      email: string;
      emailVerified: boolean;
      providerId: string;
    }> = await pool.query(
      'SELECT u.id,u.email,u."emailVerified",a."providerId" FROM auth."user" u JOIN auth."account" a ON a."userId"=u.id WHERE u.id=$1',
      [person.personId],
    );
    assert.deepEqual(result.rows, [
      { id: person.personId, email: person.email, emailVerified: true, providerId: "credential" },
    ]);
  }
  await pool.query(
    "INSERT INTO organization_departments(department_id,name,short_name,email,city,active) VALUES ('receipt-department-0095','Synthetic0095','Synthetic0095','dept0095@example.invalid','Synthetic',true)",
  );
  const tables = [
    "economy_receipts",
    "economy_receipt_import_ledger",
    "economy_receipt_command_receipts",
    "economy_receipt_outbox",
    "economy_receipt_audit",
    "person_profiles",
    "organization_departments",
    "economy_payment_authorities",
    "economy_receipt_approval_grants",
  ];
  const snapshot = async (p = pool!) =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => {
          const rows = (
            await p.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)
          ).rows;
          return [table, digest(canonicalJson(rows))];
        }),
      ),
    );
  const credentialDigest = async (p = pool!) =>
    digest(
      canonicalJson(
        (
          await p.query(
            'SELECT u.id,u.email,u."emailVerified",a."providerId",a.password FROM auth."user" u JOIN auth."account" a ON a."userId"=u.id ORDER BY u.id',
          )
        ).rows,
      ),
    );
  const files = makeReceiptFileStore({
    stagingRoot: env.RECEIPT_STAGING_ROOT,
    committedRoot: env.RECEIPT_COMMITTED_ROOT,
  });
  const baselineBytes = Buffer.from(
    "%PDF-1.4\nPre-existing native synthetic receipt 0095\n%%EOF\n",
  );
  const baselineFile = (
    await files.stageBytes(
      new File([baselineBytes], "baseline.pdf", { type: "application/pdf" }),
      "0095-native-baseline",
      "application/pdf",
      10 * 1024 * 1024,
    )
  ).file;
  await Effect.runPromise(
    files.service.apply({
      _tag: "PromoteReceiptFile",
      effectId: "0095-native-baseline-promote",
      commandId: "0095-native-baseline",
      receiptId: "receipt-0095-baseline",
      file: baselineFile,
    }),
  );
  // Explicit pre-existing native fixture, before the measured historical import window.
  await pool.query(
    `INSERT INTO economy_receipts(receipt_id,visual_id,owner_person_id,department_id,amount_ore,currency,description,receipt_date,submitted_at,status,refund_date,payment_account_ciphertext,file_ref,file_object_key,file_content_type,file_byte_length,file_sha256,revision)
 VALUES ('receipt-0095-baseline','SYN-0095-baseline',$1,'receipt-department-0095',500,'NOK','Pre-existing synthetic native receipt','2026-08-01','2026-08-01T12:00:00Z','Pending',NULL,'synthetic:baseline',$2,$3,$4,$5,$6,0)`,
    [
      persons[0]!.personId,
      baselineFile.fileRef,
      baselineFile.objectKey,
      baselineFile.contentType,
      baselineFile.byteLength,
      baselineFile.sha256,
    ],
  );
  console.log("0095 native baseline seeded");
  const baseline = await snapshot(),
    baselineCredentials = await credentialDigest();
  command("pg_dump", ["--format=custom", "--file", join(artifacts, "baseline.dump"), pgUrl]);
  await chmod(join(artifacts, "baseline.dump"), 0o600);
  await cp(storage, join(artifacts, "baseline-files"), { recursive: true });
  const bytes = Buffer.from("%PDF-1.4\nSynthetic receipt 0095 only\n%%EOF\n");
  await writeFile(join(fixtureRoot, "receipt.pdf"), bytes);
  await writeFile(join(artifacts, "outside.pdf"), bytes);
  await symlink(join(artifacts, "outside.pdf"), join(fixtureRoot, "outside-link.pdf"));
  const file = {
    path: "receipt.pdf",
    sha256: digest(bytes),
    byteLength: bytes.length,
    contentType: "application/pdf",
  };
  const valid = {
    sourcePrimaryKey: "pending",
    destinationIdentity: "receipt-0095-pending",
    sourceUser: "legacy-owner",
    sourceDepartment: "legacy-department",
    visualId: "SYN-0095-pending",
    amountDecimal: "123.45",
    description: "Synthetic imported expense",
    receiptDate: "2026-08-20",
    submittedAt: "2026-08-21T12:00:00.000Z",
    status: "pending",
    refundDate: null as string | null,
    file: file as typeof file | null,
  };
  const variants = [
    {},
    { sourcePrimaryKey: "refunded", status: "refunded", refundDate: "2026-08-22T12:00:00.000Z" },
    { sourcePrimaryKey: "rejected", status: "rejected" },
    { sourcePrimaryKey: "amount", amountDecimal: "1.234" },
    { sourcePrimaryKey: "date", receiptDate: "not-date" },
    { sourcePrimaryKey: "status", status: "unknown" },
    { sourcePrimaryKey: "owner", sourceUser: "unmapped" },
    { sourcePrimaryKey: "department", sourceDepartment: "unmapped" },
    { sourcePrimaryKey: "missing", file: null },
    { sourcePrimaryKey: "unreadable", file: { ...file, path: "missing.pdf" } },
    { sourcePrimaryKey: "digest", file: { ...file, sha256: "0".repeat(64) } },
    { sourcePrimaryKey: "traversal", file: { ...file, path: "../outside.pdf" } },
    { sourcePrimaryKey: "symlink", file: { ...file, path: "outside-link.pdf" } },
    { sourcePrimaryKey: "mime", file: { ...file, contentType: "text/html" } },
    { sourcePrimaryKey: "duplicate", visualId: "DUP" },
    { sourcePrimaryKey: "duplicate", visualId: "DUP" },
  ];
  const rows: Array<{
    sourcePrimaryKey: string;
    destinationIdentity: string;
    data: unknown;
    rowDigest: string;
  }> = variants.map((change, index) => {
    const source = {
      ...valid,
      ...change,
      destinationIdentity: `receipt-0095-${index}`,
      visualId: change.visualId ?? `SYN-0095-${index}`,
    };
    const { sourcePrimaryKey, destinationIdentity, ...data } = source;
    return { sourcePrimaryKey, destinationIdentity, data, rowDigest: rowDigest(source) };
  });
  const malformedSource = {
    ...valid,
    sourcePrimaryKey: "malformed",
    destinationIdentity: "receipt-0095-malformed",
    description: 42,
  };
  const {
    sourcePrimaryKey: malformedKey,
    destinationIdentity: malformedDestination,
    ...malformedData
  } = malformedSource;
  rows.push({
    sourcePrimaryKey: malformedKey,
    destinationIdentity: malformedDestination,
    data: malformedData,
    rowDigest: rowDigest(malformedSource),
  });
  const manifest = decodeSnapshot({
    kind: "synthetic-receipt-import-0095",
    sourceRepository: "synthetic-legacy",
    sourceRevision: "fixture-0095-v1",
    snapshotId: "immutable-0095-v1",
    sourceWatermark: "synthetic:0",
    transformationRevision: "0095-v1",
    persons: [
      {
        sourceUser: "legacy-owner",
        personId: persons[0]!.personId,
        syntheticPaymentAccount: "synthetic:0095:not-a-payment-account",
      },
    ],
    departments: [
      { sourceDepartment: "legacy-department", departmentId: "receipt-department-0095" },
    ],
    rows,
  });
  await writeFile(join(artifacts, "manifest.json"), JSON.stringify(manifest, null, 2));
  const prepared = await prepareReceiptSnapshot(manifest, fixtureRoot, files);
  const accepted = prepared.results.filter(
    (r): r is Extract<ReceiptImportResult, { _tag: "AcceptedReceiptImport" }> =>
      r._tag === "AcceptedReceiptImport",
  );
  assert.equal(accepted.length, 3);
  assert.equal(prepared.results.length, rows.length);
  let effectAttempts = 0;
  const guard = ReceiptAuxiliaryEffects.of({
    apply: (request) =>
      Effect.sync(() => {
        effectAttempts++;
      }).pipe(
        Effect.andThen(
          Effect.fail(new ReceiptAuxiliaryEffectConflict({ effectId: request.effectId })),
        ),
      ),
  });
  const observeNoEffects = async () => {
    const result = await run(
      deliverNextReceiptOutbox("0095-guard", new Date().toISOString()).pipe(
        Effect.provideService(ReceiptAuxiliaryEffects, guard),
        Effect.provideService(ReceiptFileService, files.service),
      ),
    );
    assert.equal(result._tag, "Idle");
    assert.equal(effectAttempts, 0);
    assert.equal(
      (await pool!.query("SELECT count(*)::int AS n FROM economy_receipt_outbox")).rows[0].n,
      0,
    );
  };
  // Staged bytes precede the atomic receipt+ledger commit. Force its second insert to fail.
  await pool.query(
    "CREATE FUNCTION fail_0095() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '0095 injected ledger failure'; END $$; CREATE TRIGGER fail_0095 BEFORE INSERT ON economy_receipt_import_ledger FOR EACH ROW EXECUTE FUNCTION fail_0095()",
  );
  await assert.rejects(run(storeReceiptImportResult(accepted[0]!)));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM economy_receipts")).rows[0].n, 1);
  await observeNoEffects();
  await pool.query(
    "DROP TRIGGER fail_0095 ON economy_receipt_import_ledger; DROP FUNCTION fail_0095()",
  );
  const importAll = async () => {
    for (const result of prepared.results) {
      if (result._tag === "AcceptedReceiptImport")
        await Effect.runPromise(
          files.service.apply({
            _tag: "PromoteReceiptFile",
            effectId: `0095:${result.sourcePrimaryKey}:promote`,
            commandId: `0095:${result.sourcePrimaryKey}`,
            receiptId: result.receipt.receiptId,
            file: result.receipt.file,
          }),
        );
      await run(storeReceiptImportResult(result));
    }
  };
  await importAll();
  await observeNoEffects();
  console.log("0095 import and failure/retry passed");
  // Staging objects owned by rejected occurrences have no committed references.
  for (const file of prepared.staged) {
    if (
      !(
        await pool.query("SELECT 1 FROM economy_receipts WHERE file_ref=$1 OR file_object_key=$2", [
          file.fileRef,
          file.objectKey,
        ])
      ).rowCount
    )
      await files.cleanupStage(file);
  }
  backend = start("bun", ["run", "apps/backend/src/main.ts"], env);
  await wait(async () => {
    const response = await fetch(`${backendOrigin}/health`);
    assert.equal(response.status, 200);
  });
  const signIn = async (email: string) => {
    const response = await fetch(`${backendOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5174" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    return cookie;
  };
  console.log("0095 backend ready");
  const cookie = await signIn(persons[0]!.email),
    foreign = await signIn(persons[1]!.email);
  secretValues.push(
    cookie,
    foreign,
    ...[cookie, foreign].map((value) => value.slice(value.indexOf("=") + 1)),
  );
  const client = createPromiseClient(backendOrigin, { cookie, origin: "http://127.0.0.1:5174" });
  const reconciliationDiagnostics: Array<{
    sourcePrimaryKey: string;
    phase: string;
    reason: string;
  }> = [];
  const reconcile = async (result: (typeof accepted)[number]) => {
    let phase = "persisted fact comparison";
    const observed = await run(
      reconcileReceiptImport(result, () =>
        Effect.tryPromise({
          try: async () => {
            phase = "native owner projection";
            const list = await client.receipts.listReceipts({ query: {} });
            const item = list.body.items.find((i) => i.receiptId === result.receipt.receiptId);
            assert.ok(item);
            assert.equal(item.amountOre, result.receipt.amountOre);
            assert.equal(item.status, result.receipt.status);
            assert.equal(item.visualId, result.receipt.visualId);
            assert.ok(!JSON.stringify(item).includes("synthetic:0095:not-a-payment-account"));
            assert.ok(!JSON.stringify(item).includes(result.receipt.file.objectKey));
            phase = "native private byte download";
            const downloaded = await client.receipts.readReceiptFile({
              params: { receiptId: ReceiptId.make(result.receipt.receiptId) },
            });
            return digest(downloaded.body) === result.receipt.file.sha256;
          },
          catch: (cause) => {
            const reason = safe(String(cause));
            reconciliationDiagnostics.push({
              sourcePrimaryKey: result.sourcePrimaryKey,
              phase,
              reason,
            });
            logs.push(`reconciliation ${result.sourcePrimaryKey} ${phase}: ${reason}`);
            return new Error("fresh observation failed");
          },
        }).pipe(Effect.orElseSucceed(() => false)),
      ),
    );
    if (!observed && phase === "persisted fact comparison") {
      reconciliationDiagnostics.push({
        sourcePrimaryKey: result.sourcePrimaryKey,
        phase,
        reason: "persisted canonical fact differs from source",
      });
      logs.push(
        `reconciliation ${result.sourcePrimaryKey}: persisted canonical fact differs from source`,
      );
    }
    return observed;
  };
  const reconciliations = [];
  for (const result of accepted) {
    assert.equal(await reconcile(result), true);
    reconciliations.push({
      sourcePrimaryKey: result.sourcePrimaryKey,
      sourceOccurrence: result.sourceOccurrence,
      sourceDigest: result.provenance.sourceDigest,
      reconciled: true,
    });
    for (const deniedCookie of [foreign, undefined]) {
      const r = await fetch(`${backendOrigin}/api/receipts/${result.receipt.receiptId}/file`, {
        headers: deniedCookie ? { cookie: deniedCookie } : {},
      });
      assert.equal(r.status, deniedCookie ? 404 : 401);
      assert.ok(!Buffer.from(await r.arrayBuffer()).equals(bytes));
    }
  }
  console.log("0095 owner reads and denials passed");
  const collision = {
    ...accepted[0]!,
    sourcePrimaryKey: "destination-collision",
    receipt: { ...accepted[0]!.receipt, receiptId: ReceiptId.make("receipt-0095-baseline") },
    provenance: {
      ...accepted[0]!.provenance,
      destinationIdentity: "receipt-0095-baseline",
      sourceDigest: digest("synthetic-destination-collision-0095"),
    },
  };
  await run(storeReceiptImportResult(collision));
  const collisionLedger = (
    await pool.query(
      "SELECT result,reasons_json FROM economy_receipt_import_ledger WHERE source_primary_key='destination-collision'",
    )
  ).rows;
  assert.equal(collisionLedger[0]?.result, "Quarantined");
  assert.ok(collisionLedger[0]?.reasons_json.reasons.includes("DestinationIdentityCollision"));
  const invalidBearer = await fetch(
    `${backendOrigin}/api/receipts/${accepted[0]!.receipt.receiptId}/file`,
    { headers: { cookie, authorization: "Bearer invalid-synthetic-0095" } },
  );
  assert.equal(invalidBearer.status, 401);
  const stable = await snapshot();
  const fileDigest = async () => {
    const values = [];
    for (const result of accepted)
      values.push(
        digest(await readFile(join(env.RECEIPT_COMMITTED_ROOT, result.receipt.file.objectKey))),
      );
    return values;
  };
  const stableFiles = await fileDigest();
  await importAll();
  assert.deepEqual(await snapshot(), stable);
  assert.deepEqual(await fileDigest(), stableFiles);
  await Promise.all([
    run(storeReceiptImportResult(accepted[0]!)),
    run(storeReceiptImportResult(accepted[0]!)),
  ]);
  assert.deepEqual(await snapshot(), stable);
  await assert.rejects(
    run(
      storeReceiptImportResult({
        ...accepted[0]!,
        provenance: { ...accepted[0]!.provenance, sourceDigest: "f".repeat(64) },
      }),
    ),
  );
  const tamper = accepted[0]!;
  const copiedPath = join(env.RECEIPT_COMMITTED_ROOT, tamper.receipt.file.objectKey);
  await writeFile(copiedPath, "tampered");
  assert.equal(await reconcile(tamper), false);
  await writeFile(copiedPath, bytes);
  assert.equal(await reconcile(tamper), true);
  await pool.query("UPDATE economy_receipts SET amount_ore=amount_ore+1 WHERE receipt_id=$1", [
    tamper.receipt.receiptId,
  ]);
  assert.equal(await reconcile(tamper), false);
  await pool.query("UPDATE economy_receipts SET amount_ore=amount_ore-1 WHERE receipt_id=$1", [
    tamper.receipt.receiptId,
  ]);
  assert.equal(await reconcile(tamper), true);
  await observeNoEffects();
  const authorityTables = ["economy_payment_authorities", "economy_receipt_approval_grants"];
  const current = await snapshot();
  for (const table of authorityTables) assert.equal(current[table], baseline[table]);
  console.log("0095 replay and tamper observations passed");
  let deliveryObservation: unknown;
  if (process.env.RECEIPT_DELIVERY_REHEARSAL === "1") {
    deliveryObservation = await observeReceiptDelivery({
      pool,
      env,
      origin: backendOrigin,
      cookie,
      approverCookie: foreign,
      root,
      artifactDirectory: artifacts,
      registerSecret: (secret) => {
        secretValues.push(secret);
      },
      restart: async (nextEnv) => {
        if (backend) await stop(backend);
        backend = start("bun", ["run", "apps/backend/src/main.ts"], nextEnv);
        await wait(async () => {
          const r = await fetch(`${backendOrigin}/health`);
          assert.equal(r.status, 200);
        });
      },
    });
  }
  await stop(backend);
  backend = undefined;
  await pool.query("CREATE DATABASE receipt_0095_restored");
  const restoredUrl = `postgres://postgres@127.0.0.1:${pgPort}/receipt_0095_restored`;
  command("pg_restore", [
    "--exit-on-error",
    "--dbname",
    restoredUrl,
    join(artifacts, "baseline.dump"),
  ]);
  const restored = new Pool({ connectionString: restoredUrl });
  try {
    assert.deepEqual(await snapshot(restored), baseline);
    assert.equal(await credentialDigest(restored), baselineCredentials);
  } finally {
    await restored.end();
  }
  await cp(join(artifacts, "baseline-files"), join(artifacts, "restored-files"), {
    recursive: true,
  });
  assert.equal(
    digest(await readFile(join(artifacts, "restored-files", "committed", baselineFile.objectKey))),
    digest(baselineBytes),
  );
  evidence = {
    specId: "0095",
    deliveryObservation,
    revision,
    manifestDigest: digest(canonicalJson(manifest)),
    counts: {
      input: rows.length,
      accepted: accepted.length,
      quarantined: rows.length - accepted.length,
    },
    quarantine: prepared.results
      .filter((r) => r._tag === "QuarantinedReceiptImport")
      .map((r) => ({
        sourcePrimaryKey: r.sourcePrimaryKey,
        sourceOccurrence: r.sourceOccurrence,
        reasons: r.reasons,
        sourceDigest: r.provenance.sourceDigest,
      })),
    fileRejections: prepared.fileFailures,
    reconciliations,
    reconciliationDiagnostics,
    denials: { foreign: 404, anonymous: 401, invalidBearerWithOwnerCookie: 401 },
    supplementalDestinationCollision: {
      input: 1,
      quarantined: 1,
      reason: "DestinationIdentityCollision",
    },
    effectAttempts,
    commandOutboxEffects: 0,
    replay: {
      factsLedgerFilesUnchanged: true,
      concurrentReplay: true,
      conflictingReplayRejected: true,
    },
    failureRetry: { ledgerFailureAfterStaging: true, noVisibleFactAfterFailure: true },
    tamper: { bytesInvalidate: true, factsInvalidate: true },
    restore: {
      databaseBaseline: true,
      filesBaseline: true,
      nonemptyBaselineFileSha256: digest(baselineBytes),
      credentialsBaseline: true,
      backupSha256: digest(await readFile(join(artifacts, "baseline.dump"))),
    },
    scope:
      deliveryObservation === undefined
        ? "synthetic historical import; zero notification attempts; no password migration, production or cutover claim"
        : "synthetic historical import with zero notification attempts, followed by 0097 loopback transport acceptance; no real provider, human receipt, password migration, production or cutover claim",
  };
} catch (cause) {
  await writeFile(
    join(artifacts, "failure.json"),
    JSON.stringify(
      { revision, error: safe(String(cause)), backendDiagnostics: safe(logs.join("")) },
      null,
      2,
    ),
  );
  console.error(`0095 failure diagnostics: ${join(artifacts, "failure.json")}`);
  throw new Error("Receipt rehearsal failed; inspect sanitized failure evidence");
} finally {
  if (pool) await pool.end();
  for (const child of [...children].reverse()) await stop(child);
  await rm(pgdata, { recursive: true, force: true });
  await rm(storage, { recursive: true, force: true });
  if (process.env.RECEIPT_REOPEN_REHEARSAL === "1") {
    for (const entry of await readdir(artifacts)) {
      if (
        ![
          "failure.json",
          "0102-reopen-mobile.png",
          "0102-correction-mobile.png",
          "0102-rejected-desktop.png",
        ].includes(entry)
      )
        await rm(join(artifacts, entry), { recursive: true, force: true });
    }
  }
  cleanupOkay = true;
}
assert.ok(cleanupOkay);
const encodedEvidence = JSON.stringify(
  {
    ...(evidence as object),
    passed: true,
    cleanup:
      "owned processes exited; disposable PostgreSQL and active private storage removed; synthetic evidence retained",
  },
  null,
  2,
);
if (safe(encodedEvidence) !== encodedEvidence)
  throw new Error("Retained evidence contains a credential");
await writeFile(join(artifacts, "evidence.json"), encodedEvidence, { mode: 0o600 });
console.log(`0095 passed: ${join(artifacts, "evidence.json")}`);
