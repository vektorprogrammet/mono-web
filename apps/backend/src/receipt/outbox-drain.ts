/** Bounded delivery of one receipt's outbox effects, shared by the request drain and operator CLI. */
import { randomUUID } from "node:crypto";
import {
  Economy,
  ReceiptFileService,
  type EconomyOperations,
} from "@vektorprogrammet/domain/receipt";
import { DateTime, Effect, Option, Predicate } from "effect";
import { currentInstant } from "../authority.js";
import type { ReceiptFileStore } from "./filesystem.js";
import type { ReceiptApiConfig } from "./config.js";

const DEFAULT_OUTBOX_CLAIM_ID = `backend-${process.pid}`;

const STALE_OUTBOX_CLAIM_AGE_MS = 60_000;

const MAX_DELIVERIES_PER_DRAIN = 256;

/** The Economy operations one request drain uses. */
export type ReceiptOutboxDrainOperations = Pick<
  EconomyOperations,
  "listStaleOutboxClaims" | "recoverStaleOutboxClaim" | "deliverNextOutboxEffect"
>;

/**
 * Runs `deliverOnce` until it yields anything other than `Delivered`, at most
 * {@link MAX_DELIVERIES_PER_DRAIN} times, and returns the last result.
 */
export const repeatReceiptDelivery = <A extends { readonly _tag: string }, E, R>(
  deliverOnce: Effect.Effect<A, E, R>,
) =>
  deliverOnce.pipe(
    // A plain predicate: an inferred refinement would drop `Delivered` from the result type,
    // but exhausting `times` returns the last `Delivered` result.
    Effect.repeat({
      until: (result): boolean => !Predicate.isTagged(result, "Delivered"),
      times: MAX_DELIVERIES_PER_DRAIN - 1,
    }),
  );

const staleOutboxCutoff = (now: string): string =>
  Option.match(DateTime.make(now), {
    onNone: () => now,
    onSome: (instant) =>
      DateTime.formatIso(DateTime.subtract(instant, { milliseconds: STALE_OUTBOX_CLAIM_AGE_MS })),
  });

/**
 * Recovers stale claims for the receipt, then delivers until the outbox is idle, one delivery
 * fails, or {@link MAX_DELIVERIES_PER_DRAIN} deliveries have succeeded (`Limit`).
 * Recovery and delivery failures never fail the committed request.
 */
export const drainReceiptOutboxWith = (
  economy: ReceiptOutboxDrainOperations,
  options: { readonly config: ReceiptApiConfig; readonly outboxClaimId?: string },
  fileStore: ReceiptFileStore,
  receiptId: string,
) =>
  Effect.gen(function* () {
    const claimId = `${options.outboxClaimId ?? DEFAULT_OUTBOX_CLAIM_ID}-${randomUUID()}`;
    const claimedBefore = staleOutboxCutoff(yield* currentInstant(options.config.now));

    const staleClaimIds = yield* economy
      .listStaleOutboxClaims(claimedBefore, receiptId)
      .pipe(Effect.orElseSucceed(() => Array<string>()));

    yield* Effect.forEach(
      staleClaimIds,
      (staleClaimId) =>
        economy
          .recoverStaleOutboxClaim(staleClaimId, claimedBefore)
          .pipe(Effect.catch(() => Effect.void)),
      { discard: true },
    );

    const last = yield* repeatReceiptDelivery(
      currentInstant(options.config.now).pipe(
        Effect.flatMap((now) => economy.deliverNextOutboxEffect(claimId, now, receiptId)),
        Effect.provideService(ReceiptFileService, fileStore.service),
        Effect.orElseSucceed(() => ({ _tag: "Failed" as const })),
      ),
    );

    return Predicate.isTagged(last, "Delivered") ? ("Limit" as const) : last._tag;
  });

export const drainReceiptOutbox = (
  options: { readonly config: ReceiptApiConfig; readonly outboxClaimId?: string },
  fileStore: ReceiptFileStore,
  receiptId: string,
) => Economy.use((economy) => drainReceiptOutboxWith(economy, options, fileStore, receiptId));
