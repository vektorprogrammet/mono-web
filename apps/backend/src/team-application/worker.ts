import { randomUUID } from "node:crypto";
import {
  TeamApplications,
  type TeamApplicationOutboxDelivery,
} from "@vektorprogrammet/domain/team-application";
import { DateTime, Duration, Effect, Predicate } from "effect";
import type { TeamApplicationDeliveryConfig } from "../config.js";
import { pollForever } from "../worker-support.js";

/** Upper bound on deliveries attempted in one tick before the worker yields to its schedule. */
const DELIVERIES_PER_TICK = 16;

/**
 * Delivered and Quarantined made a held effect terminal, so the next claim selects another
 * effect. Idle, Failed, and ClaimLost wait for the schedule.
 */
const madeProgress = (result: TeamApplicationOutboxDelivery) =>
  Predicate.isTagged(result, "Delivered") || Predicate.isTagged(result, "Quarantined");

/**
 * Each tick returns abandoned claims to Failed, then delivers due envelopes until the
 * outbox is idle, an outcome makes no terminal progress, or the per-tick bound is reached.
 * A tick that ended with terminal progress starts the next one without delay. A
 * persistence failure stops the worker; the composition root then stops the process.
 */
export const runTeamApplicationDeliveryWorker = (config: TeamApplicationDeliveryConfig) =>
  Effect.gen(function* () {
    const service = yield* TeamApplications;

    const deliverOne = Effect.suspend(() =>
      service.deliverNextOutboxEffect(randomUUID(), config.sender),
    );

    const tick = Effect.gen(function* () {
      const now = yield* DateTime.now;

      yield* service.recoverStaleOutboxClaims(
        DateTime.formatIso(DateTime.subtract(now, { milliseconds: config.staleClaimMilliseconds })),
      );

      return yield* deliverOne.pipe(
        Effect.repeat({ while: madeProgress, times: DELIVERIES_PER_TICK - 1 }),
      );
    });

    return yield* pollForever(tick, {
      interval: Duration.millis(config.pollIntervalMilliseconds),
      skipDelay: madeProgress,
    });
  });
