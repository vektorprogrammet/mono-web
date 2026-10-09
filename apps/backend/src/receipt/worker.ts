import {
  deliverNextReceiptOutbox,
  listStaleReceiptOutboxClaimIds,
  recoverStaleReceiptOutbox,
} from "@vektorprogrammet/database/receipt/postgres";
import { Crypto, DateTime, Duration, Effect } from "effect";
import { pollForever } from "../worker-support.js";

/**
 * Delivers the receipt outbox on a poll. The platform `Crypto` is captured once when the worker
 * starts; each poll draws a fresh claim identity from it. A failure to draw one is a defect of the
 * platform entropy source, which `pollForever` treats like any other poll failure.
 */
export const runReceiptDeliveryWorker = (pollIntervalMilliseconds: number) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;

    return yield* pollForever(
      Effect.gen(function* () {
        // Match request-time and operator recovery. Provider timeout is at most 30 seconds.
        const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 }));

        for (const claim of yield* listStaleReceiptOutboxClaimIds(cutoff)) {
          yield* recoverStaleReceiptOutbox(claim, cutoff);
        }

        const claimId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* deliverNextReceiptOutbox(claimId, DateTime.formatIso(yield* DateTime.now));
      }),
      { interval: Duration.millis(pollIntervalMilliseconds) },
    );
  });
