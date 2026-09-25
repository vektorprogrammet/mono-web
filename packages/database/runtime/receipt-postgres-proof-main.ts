import { randomBytes } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Config, Effect, Redacted } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  makeReceiptAuxiliaryRecording,
  makeReceiptFileRecording,
} from "@vektorprogrammet/domain/receipt";
import { runReceiptFileProof } from "../src/receipt/file-proof.js";
import { runReceiptPostgresProof } from "../src/receipt/postgres-proof.js";
import { DatabaseLive } from "../src/layers.js";

/** Creates a database for one proof and drops it, with its sessions, when the scope closes. */
const disposableDatabase = (maintenanceUrl: Redacted.Redacted, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.acquireRelease(sql`CREATE DATABASE ${sql(name)}`, () =>
      sql`DROP DATABASE ${sql(name)} WITH (FORCE)`.pipe(Effect.orDie),
    );
    const url = new URL(Redacted.value(maintenanceUrl));
    url.pathname = `/${name}`;

    return {
      url: Redacted.make(url.toString()),
      applicationName: "receipt-authority-proof",
      maxConnections: 4,
    };
  });

const program = Effect.gen(function* () {
  const maintenanceUrl = yield* Config.Redacted("BACKEND_PG_URL").pipe(
    Config.withDefault(Redacted.make("postgres://receipt:receipt@127.0.0.1:55432/receipt_proof")),
  );

  const runId = yield* Effect.sync(() => randomBytes(8).toString("hex"));

  const database = (purpose: string) =>
    disposableDatabase(maintenanceUrl, `receipt_proof_${runId}_${purpose}`);

  const fileRecording = makeReceiptFileRecording();
  const auxiliaryRecording = makeReceiptAuxiliaryRecording();

  const evidence = yield* Effect.gen(function* () {
    const authorityDatabase = yield* database("authority");
    const fileDatabase = yield* database("file");
    const upgradeDatabase = yield* database("upgrade");

    const authority = yield* runReceiptPostgresProof.pipe(
      Effect.provide(DatabaseLive(authorityDatabase)),
    );

    const fileLifecycle = yield* runReceiptFileProof(
      fileRecording.snapshot,
      fileRecording.failNext,
      auxiliaryRecording.appliedEffectIds,
      upgradeDatabase,
    ).pipe(
      Effect.provide([fileRecording.layer, auxiliaryRecording.layer, DatabaseLive(fileDatabase)]),
    );

    return { authority, fileLifecycle };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      PgClient.layer({
        url: maintenanceUrl,
        applicationName: "receipt-proof-maintenance",
        maxConnections: 1,
      }),
    ),
  );

  const evidenceSha256 = sha256Hex(canonicalJsonBytes(evidence));
  yield* Effect.sync(() =>
    process.stdout.write(`${canonicalJson({ ...evidence, evidenceSha256 })}\n`),
  );
});

void Effect.runPromise(program).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
