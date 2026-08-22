import * as PgClient from "@effect/sql-pg/PgClient";
import { readFile } from "node:fs/promises";
import { Config, Effect, Redacted } from "effect";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
import { makeReceiptAuxiliaryRecording } from "./auxiliary-service.js";
import { makeReceiptFileRecording } from "./file-service.js";
import { runReceiptFileProof } from "./file-proof.js";
import { runReceiptPostgresProof } from "./postgres-proof.js";

const migrationUrl = new URL("./migrations/0001-receipt-authority.sql", import.meta.url);

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.redacted("RECEIPT_PG_URL").pipe(
    Config.withDefault(Redacted.make("postgres://receipt:receipt@127.0.0.1:55432/receipt_proof")),
  );
  const migrationSql = yield* Effect.tryPromise({
    try: () => readFile(migrationUrl, "utf8"),
    catch: (cause) => new Error(`cannot read Receipt migration: ${String(cause)}`),
  });
  const fileRecording = makeReceiptFileRecording();
  const auxiliaryRecording = makeReceiptAuxiliaryRecording();
  const postgresLayer = PgClient.layer({
    url: Redacted.make(Redacted.value(databaseUrl)),
    applicationName: "receipt-authority-proof",
    maxConnections: 4,
  });
  const evidence = yield* Effect.gen(function* () {
    const authority = yield* runReceiptPostgresProof(migrationSql);
    const fileLifecycle = yield* runReceiptFileProof(
      migrationSql,
      fileRecording.snapshot,
      fileRecording.failNext,
      auxiliaryRecording.appliedEffectIds,
    );
    return { authority, fileLifecycle };
  }).pipe(
    Effect.provide(fileRecording.layer),
    Effect.provide(auxiliaryRecording.layer),
    Effect.provide(postgresLayer),
  );
  const evidenceSha256 = sha256Hex(canonicalJsonBytes(evidence));
  yield* Effect.sync(() =>
    process.stdout.write(`${canonicalJson({ ...evidence, evidenceSha256 })}\n`),
  );
});

Effect.runPromise(Effect.scoped(program)).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
