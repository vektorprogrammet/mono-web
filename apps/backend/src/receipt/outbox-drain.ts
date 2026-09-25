/** Bounded post-commit delivery of one receipt's outbox effects within the committing request. */
import { randomUUID } from "node:crypto";
import { Economy, ReceiptFileService } from "@vektorprogrammet/domain/receipt";
import { Effect } from "effect";
import type { ReceiptFileStore } from "./filesystem.js";
import type { ReceiptApiConfig } from "./config.js";

const DEFAULT_OUTBOX_CLAIM_ID = `backend-${process.pid}`;

const STALE_OUTBOX_CLAIM_AGE_MS = 60_000;

const MAX_DELIVERIES_PER_DRAIN = 256;

const staleOutboxCutoff = (now: string): string => {
  const timestamp = Date.parse(now);

  return Number.isFinite(timestamp)
    ? new Date(timestamp - STALE_OUTBOX_CLAIM_AGE_MS).toISOString()
    : now;
};

/**
 * Recovers stale claims for the receipt, then delivers until the outbox is idle, one delivery
 * fails, or {@link MAX_DELIVERIES_PER_DRAIN} deliveries have succeeded.
 */
export const drainReceiptOutbox = (
  options: { readonly config: ReceiptApiConfig; readonly outboxClaimId?: string },
  fileStore: ReceiptFileStore,
  receiptId: string,
) =>
  Effect.gen(function* () {
    const claimId = `${options.outboxClaimId ?? DEFAULT_OUTBOX_CLAIM_ID}-${randomUUID()}`;
    const claimedBefore = staleOutboxCutoff(options.config.now());

    const staleClaimIds = yield* Economy.use(({ listStaleOutboxClaims }) =>
      listStaleOutboxClaims(claimedBefore, receiptId),
    ).pipe(Effect.orElseSucceed(() => Array<string>()));

    yield* Effect.forEach(
      staleClaimIds,
      (staleClaimId) =>
        Economy.use(({ recoverStaleOutboxClaim }) =>
          recoverStaleOutboxClaim(staleClaimId, claimedBefore),
        ).pipe(Effect.catch(() => Effect.void)),
      { discard: true },
    );

    const deliverOnce = Effect.suspend(() =>
      Economy.use(({ deliverNextOutboxEffect }) =>
        deliverNextOutboxEffect(claimId, options.config.now(), receiptId),
      ),
    ).pipe(
      Effect.provideService(ReceiptFileService, fileStore.service),
      Effect.match({
        onFailure: () => "Failed" as const,
        onSuccess: (result) => result._tag,
      }),
    );

    // `until` is a plain predicate: an inferred refinement would drop "Delivered" from the result
    // type, but exhausting `times` returns the last "Delivered" tag.
    const last = yield* deliverOnce.pipe(
      Effect.repeat({
        until: (tag): boolean => tag !== "Delivered",
        times: MAX_DELIVERIES_PER_DRAIN - 1,
      }),
    );

    return last === "Delivered" ? ("Limit" as const) : last;
  });
