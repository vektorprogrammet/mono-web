import type { TeamApplicationDeliveryOptions } from "@vektorprogrammet/database/team-application";
import {
  TeamApplications,
  type TeamApplicationOutboxDelivery,
} from "@vektorprogrammet/domain/team-application";
import { Duration, Effect, Predicate, Schedule } from "effect";
import type { TeamApplicationDeliveryConfig } from "../config.js";

/**
 * Queue settings of a delivering process. The lease refresh runs three times per stale
 * window, so only a stopped or stalled process loses the lease of its attempt.
 */
export const teamApplicationDeliveryOptions = (
  config: TeamApplicationDeliveryConfig,
): Partial<TeamApplicationDeliveryOptions> => ({
  pollInterval: Duration.millis(config.pollIntervalMilliseconds),
  lockExpiration: Duration.millis(config.staleClaimMilliseconds),
  lockRefreshInterval: Duration.millis(config.staleClaimMilliseconds / 3),
  maxAttempts: config.maxAttempts,
  retryDelayMax: Duration.millis(config.retryDelayMaxMilliseconds),
});

/**
 * Takes and delivers committed notifications while the process runs, and removes
 * completed queue items past their retention once an hour. The queue polls while it waits
 * and retries a failed attempt after its backoff. Interruption releases the attempt in
 * flight uncounted. A persistence failure stops the worker; the composition root then
 * stops the process.
 */
export const runTeamApplicationDeliveryWorker = (sender: string) =>
  TeamApplications.use((service) =>
    Effect.all(
      [
        service.deliverNextOutboxEffect(sender, Duration.infinity).pipe(Effect.forever),
        service.cleanUpDeliveryQueue.pipe(Effect.repeat(Schedule.spaced("1 hour"))),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  );

/**
 * Attempts at most `limit` notifications for a scheduler that starts delivery instead of
 * a resident worker, and stops early when no notification was taken within `idle`. Then
 * it removes completed queue items past their retention.
 */
export const drainTeamApplicationOutbox = (
  sender: string,
  options: { readonly limit: number; readonly idle: Duration.Duration },
) =>
  Effect.gen(function* () {
    const service = yield* TeamApplications;
    const outcomes: Array<TeamApplicationOutboxDelivery> = [];

    while (outcomes.length < options.limit) {
      const outcome = yield* service.deliverNextOutboxEffect(sender, options.idle);

      if (Predicate.isTagged(outcome, "Idle")) break;

      outcomes.push(outcome);
    }

    yield* service.cleanUpDeliveryQueue;

    return outcomes;
  });
