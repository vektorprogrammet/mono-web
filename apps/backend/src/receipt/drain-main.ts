/** Operator-only bounded retry of durable receipt work. No business command is issued. */
import { randomUUID } from "node:crypto";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { Database, databaseHealth } from "@vektorprogrammet/database";
import {
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
} from "@vektorprogrammet/database/receipt/postgres";
import { DateTime, Predicate, Effect, Layer, Redacted, Schema } from "effect";
import { ReceiptId } from "@vektorprogrammet/domain/receipt";
import { decodeReceiptApiConfig } from "./config.js";
import { ReceiptFileStoreLive } from "./filesystem.js";
import { ReceiptDeliveryLive, receiptDeliveryConfig } from "./delivery.js";
import { repeatReceiptDelivery } from "./outbox-drain.js";

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
  ReceiptDeliveryLive(config).pipe(Layer.provide(database)),
  ReceiptFileStoreLive(decodeReceiptApiConfig()),
);

const result = await Effect.runPromise(
  Effect.gen(function* () {
    yield* databaseHealth;
    const db = yield* Database;
    const exists = yield* db`SELECT 1 FROM economy_receipts WHERE receipt_id = ${receiptId}`;

    if (exists.length !== 1) return "NotFound";
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 }));

    for (const claim of yield* listStaleReceiptOutboxClaimIds(cutoff, receiptId))
      yield* recoverStaleReceiptOutbox(claim, cutoff);

    const last = yield* repeatReceiptDelivery(
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        return yield* deliverNextReceiptOutbox(randomUUID(), now, receiptId);
      }),
    );

    if (Predicate.isTagged(last, "Failed")) return "Failed";

    if (Predicate.isTagged(last, "Idle")) {
      const remaining =
        yield* db`SELECT 1 FROM economy_receipt_outbox WHERE receipt_id = ${receiptId} AND status <> 'Delivered' LIMIT 1`;

      return remaining.length ? "Busy" : "Complete";
    }

    return "Limit";
  }).pipe(Effect.provide(services)),
);

process.stdout.write(JSON.stringify({ result }) + "\n");

process.exitCode = result === "Complete" ? 0 : 1;
