import { randomUUID } from "node:crypto";
import {
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
} from "@vektorprogrammet/database/receipt/postgres";
import { Duration, Effect } from "effect";

export const runReceiptDeliveryWorker = (pollIntervalMilliseconds: number) =>
  Effect.forever(
    Effect.gen(function* () {
      // Match request-time and operator recovery. Provider timeout is at most 30 seconds.
      const cutoff = new Date(Date.now() - 60_000).toISOString();

      for (const claim of yield* listStaleReceiptOutboxClaimIds(cutoff)) {
        yield* recoverStaleReceiptOutbox(claim, cutoff);
      }

      yield* deliverNextReceiptOutbox(randomUUID(), new Date().toISOString());
      yield* Effect.sleep(Duration.millis(pollIntervalMilliseconds));
    }),
  );
