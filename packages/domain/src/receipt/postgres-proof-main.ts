import * as PgClient from "@effect/sql-pg/PgClient";
import { readFile } from "node:fs/promises";
import { Config, Effect, Redacted } from "effect";
import { renderReceiptProofEvidence, runReceiptPostgresProof } from "./postgres-proof.js";

const migrationUrl = new URL("./migrations/0001-receipt-authority.sql", import.meta.url);

const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.redacted("RECEIPT_PG_URL").pipe(
    Config.withDefault(Redacted.make("postgres://receipt:receipt@127.0.0.1:55432/receipt_proof")),
  );
  const migrationSql = yield* Effect.tryPromise({
    try: () => readFile(migrationUrl, "utf8"),
    catch: (cause) => new Error(`cannot read Receipt migration: ${String(cause)}`),
  });
  const evidence = yield* runReceiptPostgresProof(migrationSql).pipe(
    Effect.provide(
      PgClient.layer({
        url: Redacted.make(Redacted.value(databaseUrl)),
        applicationName: "receipt-authority-proof",
        maxConnections: 2,
      }),
    ),
  );
  yield* Effect.sync(() => process.stdout.write(renderReceiptProofEvidence(evidence)));
});

Effect.runPromise(Effect.scoped(program)).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
