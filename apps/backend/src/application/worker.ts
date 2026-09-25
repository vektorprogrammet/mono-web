import { DateTime, Duration, Predicate, Effect } from "effect";
import { Database } from "@vektorprogrammet/database";
import {
  deliverNextPublicApplicationOutbox,
  recoverAllStalePublicApplicationOutbox,
} from "@vektorprogrammet/database/application";
import type {
  PublicApplicationEffectInterpreter,
  PublicApplicationPersistenceError,
} from "@vektorprogrammet/domain/application";
import { pollForever } from "../worker-support.js";

export interface PublicApplicationOutboxWorkerOptions {
  readonly workerId: string;
  readonly pollIntervalMilliseconds: number;
  readonly staleClaimMilliseconds: number;
  readonly onStart?: () => void;
  readonly onStop?: () => void;
}

const requirePositiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
};

export const runPublicApplicationOutboxWorker = (
  interpreter: PublicApplicationEffectInterpreter,
  options: PublicApplicationOutboxWorkerOptions,
): Effect.Effect<never, PublicApplicationPersistenceError, Database> => {
  requirePositiveInteger(options.pollIntervalMilliseconds, "poll interval");
  requirePositiveInteger(options.staleClaimMilliseconds, "stale claim interval");

  if (options.workerId.length === 0) throw new Error("worker ID must not be empty");

  let claimSequence = 0;

  const tick = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);

    return yield* deliverNextPublicApplicationOutbox(
      `${options.workerId}:${claimSequence++}`,
      now,
      interpreter,
    );
  });

  return Effect.gen(function* () {
    const now = yield* DateTime.now;

    const claimedBefore = DateTime.formatIso(
      DateTime.subtract(now, { milliseconds: options.staleClaimMilliseconds }),
    );

    yield* recoverAllStalePublicApplicationOutbox(claimedBefore);
    options.onStart?.();

    return yield* pollForever(tick, {
      interval: Duration.millis(options.pollIntervalMilliseconds),
      skipDelay: Predicate.isTagged("Delivered"),
    });
  }).pipe(Effect.ensuring(Effect.sync(() => options.onStop?.())));
};
