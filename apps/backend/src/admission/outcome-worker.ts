/**
 * The delivery worker of announced admission outcome mail (spec 0027).
 *
 * After the announcing transaction commits, the worker claims one queued envelope at a time under
 * the claim-fenced outbox lifecycle and forwards it, exactly as stored, to the configured Mail
 * service with the existing `MAIL_SENDER`. It never renders and never reads a template, and a
 * provider answer never changes the final outcome. The composition root runs it only when
 * `ADMISSIONS_OUTCOME_DELIVERY_MODE=http`.
 */
import {
  deliverNextOutcomeMail,
  recoverStaleOutcomeMail,
} from "@vektorprogrammet/database/admissions/outcome-mail-queue";
import { DateTime, Duration, Effect, Predicate } from "effect";
import type { AdmissionOutcomeDeliveryConfig } from "../config.js";
import { pollForever } from "../worker-support.js";

/** One tick: return stale claims to Failed, then claim and attempt the next due message. */
const outcomeDeliveryTick = (config: AdmissionOutcomeDeliveryConfig, claimId: string) =>
  Effect.gen(function* () {
    const claimedAt = yield* DateTime.now;

    yield* recoverStaleOutcomeMail(
      DateTime.formatIso(
        DateTime.subtract(claimedAt, { milliseconds: config.staleClaimMilliseconds }),
      ),
    );

    return yield* deliverNextOutcomeMail({
      claimId,
      claimedAt: DateTime.formatIso(claimedAt),
      sender: config.sender,
      maxAttempts: config.maxAttempts,
      retryDelayMaxSeconds: Math.max(1, Math.ceil(config.retryDelayMaxMilliseconds / 1000)),
    });
  });

export const runAdmissionOutcomeDeliveryWorker = (
  config: AdmissionOutcomeDeliveryConfig,
  workerId: string,
) => {
  let sequence = 0;

  return pollForever(
    Effect.suspend(() => outcomeDeliveryTick(config, `${workerId}:${sequence++}`)),
    {
      interval: Duration.millis(config.pollIntervalMilliseconds),
      skipDelay: Predicate.isTagged("Delivered"),
    },
  );
};
