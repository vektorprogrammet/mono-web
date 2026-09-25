import { randomUUID } from "node:crypto";
import {
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
} from "@vektorprogrammet/database/receipt/postgres";
import { DateTime, Duration, Effect } from "effect";
import { pollForever } from "../worker-support.js";

export const runReceiptDeliveryWorker = (pollIntervalMilliseconds: number) =>
  pollForever(
    Effect.gen(function* () {
      // Match request-time and operator recovery. Provider timeout is at most 30 seconds.
      const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 }));

      for (const claim of yield* listStaleReceiptOutboxClaimIds(cutoff)) {
        yield* recoverStaleReceiptOutbox(claim, cutoff);
      }

      yield* deliverNextReceiptOutbox(randomUUID(), DateTime.formatIso(yield* DateTime.now));
    }),
    { interval: Duration.millis(pollIntervalMilliseconds) },
  );
