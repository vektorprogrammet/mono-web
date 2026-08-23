import { Config, Effect, Redacted } from "effect";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  makeReceiptAuxiliaryRecording,
  makeReceiptFileRecording,
} from "@vektorprogrammet/domain/receipt";
import {
  runReceiptFileProof,
  runReceiptPostgresProof,
} from "@vektorprogrammet/domain/receipt/proof";
import { DatabaseLive } from "./layers.js";

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.redacted("BACKEND_PG_URL").pipe(
    Config.withDefault(Redacted.make("postgres://receipt:receipt@127.0.0.1:55432/receipt_proof")),
  );
  const fileRecording = makeReceiptFileRecording();
  const auxiliaryRecording = makeReceiptAuxiliaryRecording();
  const databaseLayer = DatabaseLive({
    url: Redacted.make(Redacted.value(databaseUrl)),
    applicationName: "receipt-authority-proof",
    maxConnections: 4,
  });
  const evidence = yield* Effect.gen(function* () {
    const authority = yield* runReceiptPostgresProof;
    const fileLifecycle = yield* runReceiptFileProof(
      fileRecording.snapshot,
      fileRecording.failNext,
      auxiliaryRecording.appliedEffectIds,
    );
    return { authority, fileLifecycle };
  }).pipe(
    Effect.provide(fileRecording.layer),
    Effect.provide(auxiliaryRecording.layer),
    Effect.provide(databaseLayer),
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
