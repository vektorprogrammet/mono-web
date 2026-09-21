/** Operator-only bounded retry of durable receipt work. No business command is issued. */
import { randomUUID } from "node:crypto";
import { DatabaseLive } from "@vektorprogrammet/database";
import { Database, databaseHealth } from "@vektorprogrammet/database";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
} from "@vektorprogrammet/domain/receipt";
import { ReceiptFileService, ReceiptId } from "@vektorprogrammet/domain/receipt";
import { makeReceiptApiConfig } from "./config.js";
import { makeReceiptFileStore } from "./filesystem.js";
import { makeReceiptDeliveryLayer, receiptDeliveryConfig } from "./delivery.js";
const receiptId = process.argv[2];
if (!receiptId || process.argv.length !== 3 || !process.env.BACKEND_PG_URL)
  throw new TypeError("Usage: BACKEND_PG_URL=... bun run src/receipt/drain-main.ts <receipt-id>");
Schema.decodeUnknownSync(ReceiptId)(receiptId);
if (!process.env.RECEIPT_STAGING_ROOT || !process.env.RECEIPT_COMMITTED_ROOT)
  throw new TypeError("Explicit receipt staging and committed roots required");
const config = receiptDeliveryConfig(process.env);
if (!config) throw new TypeError("Receipt delivery is not configured");
const database = DatabaseLive({
  url: Redacted.make(process.env.BACKEND_PG_URL),
  maxConnections: 2,
});
const services = Layer.mergeAll(
  database,
  makeReceiptDeliveryLayer(config).pipe(Layer.provide(database)),
  Layer.succeed(ReceiptFileService, makeReceiptFileStore(makeReceiptApiConfig()).service),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    yield* databaseHealth;
    const db = yield* Database;
    const exists = yield* db`SELECT 1 FROM economy_receipts WHERE receipt_id = ${receiptId}`;
    if (exists.length !== 1) return "NotFound";
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    for (const claim of yield* listStaleReceiptOutboxClaimIds(cutoff, receiptId))
      yield* recoverStaleReceiptOutbox(claim, cutoff);
    for (let count = 0; count < 256; count++) {
      const next = yield* deliverNextReceiptOutbox(
        randomUUID(),
        new Date().toISOString(),
        receiptId,
      );
      if (next._tag === "Failed") return "Failed";
      if (next._tag === "Idle") {
        const sql = yield* Database;
        const remaining =
          yield* sql`SELECT 1 FROM economy_receipt_outbox WHERE receipt_id = ${receiptId} AND status <> 'Delivered' LIMIT 1`;
        return remaining.length ? "Busy" : "Complete";
      }
    }
    return "Limit";
  }).pipe(Effect.provide(services)),
);
process.stdout.write(JSON.stringify({ result }) + "\n");
process.exitCode = result === "Complete" ? 0 : 1;
