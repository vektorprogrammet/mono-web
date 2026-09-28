/** 0095: owned local PostgreSQL/auth/RPC/files import and restore rehearsal. */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  canonicalJsonBytes,
  canonicalJsonValue,
  sha256Hex,
} from "@vektorprogrammet/domain/shared-kernel";
import { ReceiptOutboxRequestSchema } from "@vektorprogrammet/domain/receipt";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { observeReceiptDelivery } from "./receipt-delivery-observation.js";
import { Pool, type QueryResultRow } from "pg";
import { postgresProgram, reserveLoopbackPorts, startDisposablePostgres } from "@monoweb/postgres";
import {
  Cause,
  Config,
  Console,
  Data,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
  Schema,
  Scope,
  Stream,
  Struct,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import {
  storeReceiptImportResult,
  reconcileReceiptImport,
  deliverNextReceiptOutbox,
} from "@vektorprogrammet/database/receipt/postgres";
import {
  ReceiptAuxiliaryEffects,
  ReceiptAuxiliaryEffectConflict,
} from "@vektorprogrammet/domain/receipt";
import { ReceiptFileService } from "@vektorprogrammet/domain/receipt";
import type { ReceiptImportResult } from "@vektorprogrammet/domain/receipt";
import { ReceiptId } from "@vektorprogrammet/domain/receipt";
import { nativeScriptClient } from "@vektorprogrammet/rpc/script";
import {
  ReceiptFileStoreResource,
  ReceiptFileStoreLive,
} from "@vektorprogrammet/backend/receipt/filesystem";
import {
  decodeSnapshot,
  digest,
  rowDigest,
  prepareReceiptSnapshot,
} from "@vektorprogrammet/backend/receipt/import-snapshot";
import { commandOutput, indentedJsonText } from "../acceptance/acceptance-process.js";
import { firstSetCookie, jsonText, step, surfaceStepFailure } from "../acceptance/journey-step.js";

/** The rehearsal failed; its sanitized evidence names the cause. */
class ReceiptRehearsalFailed extends Data.TaggedError("ReceiptRehearsalFailed")<{
  readonly message: string;
}> {}

/** A step of the rehearsal that outlived its bound. */
class ReceiptRehearsalTimeout extends Data.TaggedError("ReceiptRehearsalTimeout")<{
  readonly message: string;
}> {}

/** One `pg` query as a step; a rejection fails the step with the original error. */
// oxlint-disable-next-line typescript/no-explicit-any -- pg types an untyped row as any, as the calls did
const query = <Row extends QueryResultRow = any>(
  target: Pool,
  text: string,
  values?: ReadonlyArray<unknown>,
) => step(() => target.query<Row>(text, values === undefined ? undefined : [...values]));

/** Asserts that the effect fails or dies, as `assert.rejects` did for its promise. */
const rejects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => assert.ok(Exit.isFailure(exit), "Missing expected rejection.")),
  );

/** Whether the owned backend answers its health check with 200; a failure fails the check. */
const healthAnswers200 = (origin: string) =>
  HttpClient.get(`${origin}/health`).pipe(
    Effect.map((response) => assert.equal(response.status, 200)),
  );

/** Retries the check every 100 ms, 150 times, as the owned runtime starts. */
const wait = <A, E, R>(check: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    for (let n = 0; n < 150; n++) {
      const exit = yield* Effect.exit(check);

      if (Exit.isSuccess(exit)) return;

      yield* Effect.sleep("100 millis");
    }

    return yield* new ReceiptRehearsalTimeout({ message: "owned runtime startup timed out" });
  });

type OwnedChild = ChildProcessSpawner.ChildProcessHandle;

const rehearsal = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const join = path.join;
  const root = path.resolve(import.meta.dirname, "../..");

  const command = (
    name: string,
    args: ReadonlyArray<string>,
    env: Readonly<Record<string, string | undefined>> = {},
  ) =>
    commandOutput({ command: name, args, cwd: root, env, deadline: "60 seconds", stderr: "pipe" });

  const revision = (yield* command("git", ["rev-parse", "HEAD"])).trim();

  assert.equal(
    (yield* command("git", ["status", "--porcelain"])).trim(),
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
    assert.ok(
      Option.getOrElse(yield* Config.option(Config.String(key)), () => "") === "",
      `unset provider configuration: ${key}`,
    );

  const reopenRehearsal = Option.contains(
    yield* Config.option(Config.String("RECEIPT_REOPEN_REHEARSAL")),
    "1",
  );

  const artifacts = yield* fileSystem.makeTempDirectory({ prefix: "vektor-receipt-0095-" });

  const storage = join(artifacts, "storage");

  const fixtureRoot = join(artifacts, "source");

  yield* fileSystem.makeDirectory(fixtureRoot);

  yield* fileSystem.makeDirectory(storage);

  const logs: string[] = [];

  const secretValues: string[] = [];

  const safe = (value: string) =>
    secretValues.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);

  const main = Effect.gen(function* () {
    const rehearsalScope = yield* Effect.scope;

    /** Starts an owned child in the rehearsal scope; it keeps the last 30 chunks of standard error. */
    const start = (
      name: string,
      args: ReadonlyArray<string>,
      env: Readonly<Record<string, string | undefined>>,
    ) =>
      Effect.gen(function* () {
        const child = yield* ChildProcess.make(name, args, {
          cwd: root,
          env: { ...env },
          extendEnv: true,
          stdin: "ignore",
          forceKillAfter: "5 seconds",
        });

        yield* child.stdout.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
        yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((text) =>
            Effect.sync(() => {
              logs.push(text);

              if (logs.length > 30) logs.shift();
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );

        return child;
      }).pipe(Effect.provideService(Scope.Scope, rehearsalScope));

    /** Stops an owned child: SIGTERM, SIGKILL after five seconds, and a failure after fifteen. */
    const stop = (child: OwnedChild) =>
      Effect.gen(function* () {
        if (!(yield* child.isRunning)) return;

        yield* child.kill({ forceKillAfter: "5 seconds" }).pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () =>
              Effect.fail(new ReceiptRehearsalTimeout({ message: "owned child did not exit" })),
          }),
        );
      });

    let backend: OwnedChild | undefined;

    const [backendPort, dashboardPort] = yield* step(() => reserveLoopbackPorts(2));

    const dashboardOrigin = `http://127.0.0.1:${dashboardPort}`;

    const postgres = yield* Effect.acquireRelease(
      step(() => startDisposablePostgres({ database: "receipt_0095" })),
      (owned) => Effect.promise(() => owned.stop()),
    );

    const pgUrl = postgres.url;

    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: pgUrl })),
      (owned) => Effect.promise(() => owned.end()),
    );

    const databaseLayer = DatabaseLive({ url: Redacted.make(pgUrl), maxConnections: 2 });

    const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
      program.pipe(Effect.provide(databaseLayer));

    // The database health check of the migrated schema.
    yield* run(SqlClient.SqlClient.use((sql) => sql`SELECT 1 AS ready`));
    yield* Console.log("0095 database migrated");
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
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(backendPort),
      BACKEND_PG_URL: pgUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      NATIVE_IDENTITY_DEPLOYMENT: "local",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: yield* jsonText([dashboardOrigin]),
      OAUTH_CANONICAL_ORIGIN: backendOrigin,
      OAUTH_DASHBOARD_ORIGIN: dashboardOrigin,
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
      PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
      PASSWORD_RESET_DELIVERY_MODE: "disabled",
      RECEIPT_DELIVERY_MODE: "disabled",
      RECEIPT_STAGING_ROOT: join(storage, "staging"),
      RECEIPT_COMMITTED_ROOT: join(storage, "committed"),
    };

    secretValues.push(env.BETTER_AUTH_SECRET);
    yield* command("bun", ["run", "packages/database/runtime/identity-seed-main.ts"], {
      ...env,
      IDENTITY_SEED_PG_URL: pgUrl,
      IDENTITY_SEED_PERSONS: yield* jsonText(persons),
    });

    for (const person of persons) {
      const result = yield* query<{
        id: string;
        email: string;
        emailVerified: boolean;
        providerId: string;
      }>(
        pool,

        'SELECT u.id,u.email,u."emailVerified",a."providerId" FROM auth."user" u JOIN auth."account" a ON a."userId"=u.id WHERE u.id=$1',
        [person.personId],
      );

      assert.deepEqual(result.rows, [
        { id: person.personId, email: person.email, emailVerified: true, providerId: "credential" },
      ]);
    }

    yield* query(
      pool,
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

    const snapshot = (p: Pool = pool) =>
      Effect.forEach(
        tables,
        (table) =>
          query(p, `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`).pipe(
            Effect.map((result) => [table, sha256Hex(canonicalJsonBytes(result.rows))] as const),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((entries) => Object.fromEntries(entries)));

    const credentialDigest = (p: Pool = pool) =>
      query(
        p,
        'SELECT u.id,u.email,u."emailVerified",a."providerId",a.password FROM auth."user" u JOIN auth."account" a ON a."userId"=u.id ORDER BY u.id',
      ).pipe(Effect.map((result) => sha256Hex(canonicalJsonBytes(result.rows))));

    const files = yield* ReceiptFileStoreResource.pipe(
      Effect.provide(
        ReceiptFileStoreLive({
          stagingRoot: env.RECEIPT_STAGING_ROOT,
          committedRoot: env.RECEIPT_COMMITTED_ROOT,
        }),
      ),
    );

    const baselineBytes = Buffer.from(
      "%PDF-1.4\nPre-existing native synthetic receipt 0095\n%%EOF\n",
    );

    const baselineFile = (yield* files.stageBytes(
      new File([baselineBytes], "baseline.pdf", { type: "application/pdf" }),
      "0095-native-baseline",
      "application/pdf",
      10 * 1024 * 1024,
    )).file;

    yield* files.service.apply(
      ReceiptOutboxRequestSchema.cases.PromoteReceiptFile.make({
        effectId: "0095-native-baseline-promote",
        commandId: "0095-native-baseline",
        receiptId: "receipt-0095-baseline",
        file: baselineFile,
      }),
    );
    // Explicit pre-existing native fixture, before the measured historical import window.
    yield* query(
      pool,
      `INSERT INTO economy_receipts(receipt_id,visual_id,owner_person_id,department_id,amount_ore,currency,description,receipt_date,submitted_at,status,approved_at,payment_account_ciphertext,file_ref,file_object_key,file_content_type,file_byte_length,file_sha256,revision)
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
    yield* Console.log("0095 native baseline seeded");

    const baseline = yield* snapshot(),
      baselineCredentials = yield* credentialDigest();

    yield* command(postgresProgram("pg_dump"), [
      "--format=custom",
      "--file",
      join(artifacts, "baseline.dump"),
      pgUrl,
    ]);
    yield* fileSystem.chmod(join(artifacts, "baseline.dump"), 0o600);
    yield* fileSystem.copy(storage, join(artifacts, "baseline-files"));
    const bytes = Buffer.from("%PDF-1.4\nSynthetic receipt 0095 only\n%%EOF\n");
    yield* fileSystem.writeFile(join(fixtureRoot, "receipt.pdf"), bytes);
    yield* fileSystem.writeFile(join(artifacts, "outside.pdf"), bytes);
    yield* fileSystem.symlink(
      join(artifacts, "outside.pdf"),
      join(fixtureRoot, "outside-link.pdf"),
    );

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
      refundDate: null,
      file,
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

    yield* fileSystem.writeFileString(
      join(artifacts, "manifest.json"),
      yield* indentedJsonText(manifest),
    );

    const prepared = yield* prepareReceiptSnapshot(manifest, fixtureRoot, files);

    const accepted = prepared.results.filter(
      (r): r is Extract<ReceiptImportResult, { _tag: "AcceptedReceiptImport" }> =>
        Predicate.isTagged(r, "AcceptedReceiptImport"),
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
            Effect.fail(ReceiptAuxiliaryEffectConflict.make({ effectId: request.effectId })),
          ),
        ),
    });

    const observeNoEffects = Effect.fnUntraced(function* () {
      const claimedAt = DateTime.formatIso(yield* DateTime.now);

      const result = yield* run(
        deliverNextReceiptOutbox({ claimId: "0095-guard", claimedAt }).pipe(
          Effect.provideService(ReceiptAuxiliaryEffects, guard),
          Effect.provideService(ReceiptFileService, files.service),
        ),
      );

      assert.equal(result._tag, "Idle");
      assert.equal(effectAttempts, 0);
      assert.equal(
        (yield* query(pool, "SELECT count(*)::int AS n FROM economy_receipt_outbox")).rows[0].n,
        0,
      );
    });

    // Staged bytes precede the atomic receipt+ledger commit. Force its second insert to fail.
    yield* query(
      pool,
      "CREATE FUNCTION fail_0095() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '0095 injected ledger failure'; END $$; CREATE TRIGGER fail_0095 BEFORE INSERT ON economy_receipt_import_ledger FOR EACH ROW EXECUTE FUNCTION fail_0095()",
    );
    yield* storeReceiptImportResult(accepted[0]!).pipe(run, rejects);
    assert.equal(
      (yield* query(pool, "SELECT count(*)::int AS n FROM economy_receipts")).rows[0].n,
      1,
    );
    yield* observeNoEffects();
    yield* query(
      pool,
      "DROP TRIGGER fail_0095 ON economy_receipt_import_ledger; DROP FUNCTION fail_0095()",
    );

    const importAll = Effect.fnUntraced(function* () {
      for (const result of prepared.results) {
        if (Predicate.isTagged(result, "AcceptedReceiptImport"))
          yield* files.service.apply(
            ReceiptOutboxRequestSchema.cases.PromoteReceiptFile.make({
              effectId: `0095:${result.sourcePrimaryKey}:promote`,
              commandId: `0095:${result.sourcePrimaryKey}`,
              receiptId: result.receipt.receiptId,
              file: result.receipt.file,
            }),
          );
        yield* run(storeReceiptImportResult(result));
      }
    });

    yield* importAll();
    yield* observeNoEffects();
    yield* Console.log("0095 import and failure/retry passed");

    // Staging objects owned by rejected occurrences have no committed references.
    for (const file of prepared.staged) {
      if (
        ((yield* query(
          pool,
          "SELECT 1 FROM economy_receipts WHERE file_ref=$1 OR file_object_key=$2",
          [file.fileRef, file.objectKey],
        )).rowCount ?? 0) === 0
      )
        yield* files.cleanupStage(file);
    }

    backend = yield* start("bun", ["run", "apps/backend/src/main.ts"], env);
    yield* wait(healthAnswers200(backendOrigin));

    const signIn = Effect.fnUntraced(function* (email: string) {
      const response = yield* HttpClient.execute(
        HttpClientRequest.post(`${backendOrigin}/api/auth/sign-in/email`).pipe(
          HttpClientRequest.setHeader("origin", dashboardOrigin),
          HttpClientRequest.bodyText(yield* jsonText({ email, password }), "application/json"),
        ),
      );

      assert.equal(response.status, 200);
      const cookie = firstSetCookie(response);
      assert.ok(cookie !== undefined && cookie.length > 0);

      return cookie;
    });

    yield* Console.log("0095 backend ready");

    const cookie = yield* signIn(persons[0]!.email),
      foreign = yield* signIn(persons[1]!.email);

    secretValues.push(
      cookie,
      foreign,
      ...[cookie, foreign].map((value) => value.slice(value.indexOf("=") + 1)),
    );
    const native = nativeScriptClient(backendOrigin);

    const ownerHeaders = { cookie, origin: dashboardOrigin };

    const reconciliationDiagnostics: Array<{
      sourcePrimaryKey: string;
      phase: string;
      reason: string;
    }> = [];

    const reconcile = Effect.fnUntraced(function* (result: (typeof accepted)[number]) {
      let phase = "persisted fact comparison";

      const observed = yield* run(
        reconcileReceiptImport(result, () =>
          Effect.gen(function* () {
            phase = "native owner projection";

            const list = yield* step(() =>
              native.call(ownerHeaders, (client) => client["receipts.listReceipts"]({})),
            );

            assert.ok(
              list.ok,
              `listReceipts answered ${list.status}: ${list.ok ? "" : "defect" in list ? list.defect : list.code}`,
            );
            const item = list.value.items.find((i) => i.receiptId === result.receipt.receiptId);
            assert.ok(item);
            assert.equal(item.amountOre, result.receipt.amountOre);
            assert.equal(item.status, result.receipt.status);
            assert.equal(item.visualId, result.receipt.visualId);
            const itemText = yield* jsonText(item);
            assert.ok(!itemText.includes("synthetic:0095:not-a-payment-account"));
            assert.ok(!itemText.includes(result.receipt.file.objectKey));
            phase = "native private byte download";

            const downloaded = yield* step(() =>
              native.call(ownerHeaders, (client) =>
                client["receipts.readReceiptFile"]({
                  receiptId: ReceiptId.make(result.receipt.receiptId),
                }),
              ),
            );

            assert.ok(downloaded.ok, `readReceiptFile answered ${downloaded.status}`);

            return digest(downloaded.value.bytes) === result.receipt.file.sha256;
          }).pipe(
            surfaceStepFailure,
            // A failed observation, an assertion included, records its phase and counts as false.
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                const reason = safe(String(Cause.squash(cause)));
                reconciliationDiagnostics.push({
                  sourcePrimaryKey: result.sourcePrimaryKey,
                  phase,
                  reason,
                });
                logs.push(`reconciliation ${result.sourcePrimaryKey} ${phase}: ${reason}`);

                return false;
              }),
            ),
          ),
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
    });

    const reconciliations = [];

    for (const result of accepted) {
      assert.equal(yield* reconcile(result), true);
      reconciliations.push({
        sourcePrimaryKey: result.sourcePrimaryKey,
        sourceOccurrence: result.sourceOccurrence,
        sourceDigest: result.provenance.sourceDigest,
        reconciled: true,
      });

      for (const deniedCookie of [foreign, undefined]) {
        const denied = yield* step(() =>
          native.call(
            deniedCookie === undefined
              ? { origin: dashboardOrigin }
              : { cookie: deniedCookie, origin: dashboardOrigin },
            (client) =>
              client["receipts.readReceiptFile"]({
                receiptId: ReceiptId.make(result.receipt.receiptId),
              }),
          ),
        );

        // A foreign owner is told the file does not exist; no credential is told to present one.
        assert.equal(denied.ok, false);
        assert.equal(denied.status, deniedCookie === undefined ? 401 : 404);
      }
    }

    yield* Console.log("0095 owner reads and denials passed");

    const collision = {
      ...accepted[0]!,
      sourcePrimaryKey: "destination-collision",
      receipt: Struct.assign(accepted[0]!.receipt, {
        receiptId: ReceiptId.make("receipt-0095-baseline"),
      }),
      provenance: {
        ...accepted[0]!.provenance,
        destinationIdentity: "receipt-0095-baseline",
        sourceDigest: digest("synthetic-destination-collision-0095"),
      },
    };

    yield* run(storeReceiptImportResult(collision));

    const collisionLedger = (yield* query(
      pool,
      "SELECT result,reasons_json FROM economy_receipt_import_ledger WHERE source_primary_key='destination-collision'",
    )).rows;

    assert.equal(collisionLedger[0]?.result, "Quarantined");
    assert.ok(collisionLedger[0]?.reasons_json.reasons.includes("DestinationIdentityCollision"));

    const invalidBearer = yield* step(() =>
      native.call(
        { cookie, authorization: "Bearer invalid-synthetic-0095", origin: dashboardOrigin },
        (client) =>
          client["receipts.readReceiptFile"]({
            receiptId: ReceiptId.make(accepted[0]!.receipt.receiptId),
          }),
      ),
    );

    assert.equal(invalidBearer.status, 401);
    const stable = yield* snapshot();

    const fileDigest = Effect.fnUntraced(function* () {
      const values = [];

      for (const result of accepted)
        values.push(
          digest(
            yield* fileSystem.readFile(
              join(env.RECEIPT_COMMITTED_ROOT, result.receipt.file.objectKey),
            ),
          ),
        );

      return values;
    });

    const stableFiles = yield* fileDigest();
    yield* importAll();
    assert.deepEqual(yield* snapshot(), stable);
    assert.deepEqual(yield* fileDigest(), stableFiles);
    yield* Effect.all(
      [run(storeReceiptImportResult(accepted[0]!)), run(storeReceiptImportResult(accepted[0]!))],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(yield* snapshot(), stable);
    yield* storeReceiptImportResult({
      ...accepted[0]!,
      provenance: { ...accepted[0]!.provenance, sourceDigest: "f".repeat(64) },
    }).pipe(run, rejects);
    const tamper = accepted[0]!;
    const copiedPath = join(env.RECEIPT_COMMITTED_ROOT, tamper.receipt.file.objectKey);
    yield* fileSystem.writeFileString(copiedPath, "tampered");
    assert.equal(yield* reconcile(tamper), false);
    yield* fileSystem.writeFile(copiedPath, bytes);
    assert.equal(yield* reconcile(tamper), true);
    yield* query(pool, "UPDATE economy_receipts SET amount_ore=amount_ore+1 WHERE receipt_id=$1", [
      tamper.receipt.receiptId,
    ]);
    assert.equal(yield* reconcile(tamper), false);
    yield* query(pool, "UPDATE economy_receipts SET amount_ore=amount_ore-1 WHERE receipt_id=$1", [
      tamper.receipt.receiptId,
    ]);
    assert.equal(yield* reconcile(tamper), true);
    // Every reconciliation reads the owner projection through the script client, so it lives until
    // the last one; a disposed client fails each read, which a tamper check would count as detection.
    yield* step(() => native.dispose());
    yield* observeNoEffects();
    const authorityTables = ["economy_payment_authorities", "economy_receipt_approval_grants"];
    const current = yield* snapshot();

    for (const table of authorityTables) assert.equal(current[table], baseline[table]);
    yield* Console.log("0095 replay and tamper observations passed");

    const observeDelivery = () =>
      observeReceiptDelivery({
        pool,
        env,
        origin: backendOrigin,
        dashboardOrigin,
        cookie,
        approverCookie: foreign,
        root,
        artifactDirectory: artifacts,
        registerSecret: (secret) => {
          secretValues.push(secret);
        },
        restart: (nextEnv) =>
          Effect.gen(function* () {
            if (backend !== undefined) yield* stop(backend);
            backend = yield* start("bun", ["run", "apps/backend/src/main.ts"], nextEnv);
            yield* wait(healthAnswers200(backendOrigin));
          }),
      }).pipe(Effect.provide(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" })));

    const deliveryObservation = Option.contains(
      yield* Config.option(Config.String("RECEIPT_DELIVERY_REHEARSAL")),
      "1",
    )
      ? yield* observeDelivery()
      : null;

    if (backend !== undefined) yield* stop(backend);
    backend = undefined;
    const restoredUrl = yield* step(() => postgres.createDatabase("receipt_0095_restored"));
    yield* command(postgresProgram("pg_restore"), [
      "--exit-on-error",
      "--dbname",
      restoredUrl,
      join(artifacts, "baseline.dump"),
    ]);
    yield* Effect.acquireUseRelease(
      Effect.sync(() => new Pool({ connectionString: restoredUrl })),
      (restored) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* snapshot(restored), baseline);
          assert.equal(yield* credentialDigest(restored), baselineCredentials);
        }),
      (restored) => Effect.promise(() => restored.end()),
    );

    yield* fileSystem.copy(join(artifacts, "baseline-files"), join(artifacts, "restored-files"));
    assert.equal(
      digest(
        yield* fileSystem.readFile(
          join(artifacts, "restored-files", "committed", baselineFile.objectKey),
        ),
      ),
      digest(baselineBytes),
    );

    return canonicalJsonValue({
      specId: "0095",
      deliveryObservation,
      revision,
      manifestDigest: sha256Hex(canonicalJsonBytes(manifest)),
      counts: {
        input: rows.length,
        accepted: accepted.length,
        quarantined: rows.length - accepted.length,
      },
      quarantine: prepared.results
        .filter((r) => Predicate.isTagged(r, "QuarantinedReceiptImport"))
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
        backupSha256: digest(yield* fileSystem.readFile(join(artifacts, "baseline.dump"))),
      },
      scope:
        deliveryObservation === null
          ? "synthetic historical import; zero notification attempts; no password migration, production or cutover claim"
          : "synthetic historical import with zero notification attempts, followed by 0097 loopback transport acceptance; no real provider, human receipt, password migration, production or cutover claim",
    });
  });

  const outcome = yield* Effect.exit(
    Effect.scoped(
      main.pipe(
        surfaceStepFailure,
        Effect.tapCause((cause) =>
          Effect.gen(function* () {
            yield* fileSystem.writeFileString(
              join(artifacts, "failure.json"),
              yield* indentedJsonText({
                revision,
                error: safe(String(Cause.squash(cause))),
                backendDiagnostics: safe(logs.join("")),
              }),
            );
            yield* Console.error(`0095 failure diagnostics: ${join(artifacts, "failure.json")}`);
          }),
        ),
      ),
    ),
  );

  yield* fileSystem.remove(storage, { recursive: true, force: true });

  if (reopenRehearsal) {
    for (const entry of yield* fileSystem.readDirectory(artifacts)) {
      if (
        ![
          "failure.json",
          "0102-reopen-mobile.png",
          "0102-correction-mobile.png",
          "0102-rejected-desktop.png",
          "0102-browser-failure.png",
        ].includes(entry)
      )
        yield* fileSystem.remove(join(artifacts, entry), { recursive: true, force: true });
    }
  }

  if (Exit.isFailure(outcome))
    return yield* new ReceiptRehearsalFailed({
      message: "Receipt rehearsal failed; inspect sanitized failure evidence",
    });

  const encodedEvidence = yield* indentedJsonText({
    ...(yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
      outcome.value,
    )),
    passed: true,
    cleanup:
      "owned processes exited; disposable PostgreSQL and active private storage removed; synthetic evidence retained",
  });

  if (safe(encodedEvidence) !== encodedEvidence)
    return yield* new ReceiptRehearsalFailed({
      message: "Retained evidence contains a credential",
    });

  yield* fileSystem.writeFileString(join(artifacts, "evidence.json"), encodedEvidence, {
    mode: 0o600,
  });

  yield* Console.log(`0095 passed: ${join(artifacts, "evidence.json")}`);
});

BunRuntime.runMain(
  rehearsal.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
);
