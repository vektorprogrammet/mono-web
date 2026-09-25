/**
 * Local E2E concurrency probe for receipt approval evidence.
 * Composed only when `ReceiptApiConfig.e2eTestMode` is enabled.
 */
import { Cause, Clock, Deferred, Duration, Effect } from "effect";
import { HttpSemanticFailure } from "../http-semantics.js";
import type { ReceiptApiConfig } from "./config.js";

export type ReceiptE2EConcurrencyLane = "file-read" | "approve" | "reject";

/** `false` for unprobed requests; `true` once all three lanes are synchronized. */
export type ReceiptE2EBarrierArrival = Effect.Effect<
  boolean,
  HttpSemanticFailure | Cause.TimeoutError
>;

/** Holds each probed request inside its transaction until all three lanes have arrived. */
export type ReceiptE2ETransactionBarrier = (
  request: Request,
  receiptId: string,
  lane: ReceiptE2EConcurrencyLane,
) => ReceiptE2EBarrierArrival;

export const RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER = "x-receipt-e2e-concurrency-probe";

export const RECEIPT_E2E_CONCURRENCY_RESPONSE_HEADER = "x-receipt-e2e-concurrency-synchronized";

const LANE_COUNT = 3;

const BARRIER_TIMEOUT_MS = 10_000;

/**
 * One barrier per handler composition. The timeout starts at the first probed arrival and
 * is shared by every lane; after it elapses the barrier stays expired.
 */
export const makeReceiptE2ETransactionBarrier: Effect.Effect<ReceiptE2ETransactionBarrier> =
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    const arrived = new Set<ReceiptE2EConcurrencyLane>();
    let targetReceiptId: string | undefined;
    let deadline: number | undefined;
    let synchronized = false;

    const malformed = Effect.fail(new HttpSemanticFailure("request.malformed", 400));

    const expired = Effect.fail(
      new Cause.TimeoutError("Receipt E2E transaction concurrency barrier timed out"),
    );

    return (request, receiptId, lane) =>
      Clock.clockWith((clock) =>
        Effect.suspend((): ReceiptE2EBarrierArrival => {
          const marker = request.headers.get(RECEIPT_E2E_CONCURRENCY_REQUEST_HEADER);

          if (marker === null) return Effect.succeed(false);

          if (marker !== lane) return malformed;

          targetReceiptId ??= receiptId;

          if (targetReceiptId !== receiptId) return malformed;

          if (arrived.has(lane)) return synchronized ? Effect.succeed(true) : malformed;

          const now = clock.currentTimeMillisUnsafe();
          deadline ??= now + BARRIER_TIMEOUT_MS;
          arrived.add(lane);

          if (arrived.size === LANE_COUNT) synchronized = true;

          const remaining = deadline - now;

          const wait =
            remaining <= 0
              ? expired
              : Deferred.await(released).pipe(
                  Effect.timeout(Duration.millis(remaining)),
                  Effect.as(true),
                );

          return synchronized
            ? Deferred.succeed(released, undefined).pipe(Effect.andThen(wait))
            : wait;
        }),
      );
  });

/** The barrier for one receipt handler composition; absent unless E2E test mode is enabled. */
export const receiptE2ETransactionBarrierFor = (
  config: ReceiptApiConfig,
): Effect.Effect<ReceiptE2ETransactionBarrier | undefined> =>
  config.e2eTestMode === true ? makeReceiptE2ETransactionBarrier : Effect.succeed(undefined);
