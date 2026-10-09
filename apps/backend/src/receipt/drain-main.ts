/**
 * EX-0024: required public native APIs in stable Effect 4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
/** Operator-only bounded retry of durable receipt work. No business command is issued. */
import process from "node:process";
import * as BunServices from "@effect/platform-bun/BunServices";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { NativeDatabaseStartupOptions } from "@vektorprogrammet/database/search-path";
import { Database, databaseHealth } from "@vektorprogrammet/database";
import {
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
} from "@vektorprogrammet/database/receipt/postgres";
import {
  Config,
  Crypto,
  DateTime,
  Predicate,
  Effect,
  Layer,
  Redacted,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { ReceiptId } from "@vektorprogrammet/domain/receipt";
import { decodeReceiptApiConfig } from "./config.js";
import { ReceiptFileStoreLive } from "./filesystem.js";
import { ReceiptDeliveryLive, receiptDeliveryConfig } from "./delivery.js";
import { repeatReceiptDelivery } from "./outbox-drain.js";

// An unset or empty variable is missing.
const environment = Effect.runSync(
  Config.all({
    postgresUrl: Config.String("BACKEND_PG_URL").pipe(Config.withDefault("")),
    stagingRoot: Config.String("RECEIPT_STAGING_ROOT").pipe(Config.withDefault("")),
    committedRoot: Config.String("RECEIPT_COMMITTED_ROOT").pipe(Config.withDefault("")),
  }),
);

const receiptId = process.argv[2];

if (!receiptId || process.argv.length !== 3 || !environment.postgresUrl)
  throw new TypeError("Usage: BACKEND_PG_URL=... bun run src/receipt/drain-main.ts <receipt-id>");

Result.getOrThrow(Schema.decodeResult(ReceiptId)(receiptId));

if (!environment.stagingRoot || !environment.committedRoot)
  throw new TypeError("Explicit receipt staging and committed roots required");

const config = receiptDeliveryConfig(process.env);

if (!config) throw new TypeError("Receipt delivery is not configured");

const database = DatabaseLive({
  url: Redacted.make(environment.postgresUrl),
  maxConnections: 2,
  startupOptions: NativeDatabaseStartupOptions,
}).pipe(Layer.provide(BunServices.layer));

const services = Layer.mergeAll(
  database,
  ReceiptDeliveryLive(config).pipe(Layer.provide(Layer.merge(database, FetchHttpClient.layer))),
  ReceiptFileStoreLive(decodeReceiptApiConfig()).pipe(Layer.provide(BunServices.layer)),
).pipe(Layer.provideMerge(BunServices.layer));

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
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

        return yield* deliverNextReceiptOutbox(
          yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          now,
          receiptId,
        );
      }),
    );

    if (Predicate.isTagged(last, "Failed")) return "Failed";

    if (Predicate.isTagged(last, "Delivered")) return "Limit";

    // Idle, or ClaimLost to another process: report what the receipt still waits for.
    const waiting = yield* db<{ readonly status: string }>`
      SELECT status FROM economy_receipt_outbox
      WHERE receipt_id = ${receiptId} AND status <> 'Delivered'
    `;

    // A quarantined effect is terminal and holds back the later effects of its receipt.
    if (waiting.some(({ status }) => status === "Quarantined")) return "Quarantined";

    return waiting.length > 0 ? "Busy" : "Complete";
  }).pipe(Effect.provide(services)),
);

process.stdout.write(JSON.stringify({ result }) + "\n");

process.exitCode = result === "Complete" ? 0 : 1;
