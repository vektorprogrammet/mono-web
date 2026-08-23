import { Duration, Effect } from "effect";
import type { Database } from "../database/service.js";
import type { PublicApplicationEffectInterpreter } from "./effects.js";
import type { PublicApplicationPersistenceError } from "./errors.js";
import {
  deliverNextPublicApplicationOutbox,
  recoverAllStalePublicApplicationOutbox,
} from "./outbox.js";

export interface PublicApplicationOutboxWorkerOptions {
  readonly workerId: string;
  readonly pollIntervalMilliseconds: number;
  readonly staleClaimMilliseconds: number;
  readonly now: () => string;
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
    const result = yield* deliverNextPublicApplicationOutbox(
      `${options.workerId}:${claimSequence++}`,
      options.now(),
      interpreter,
    );
    if (result._tag !== "Delivered") {
      yield* Effect.sleep(Duration.millis(options.pollIntervalMilliseconds));
    }
  });

  return Effect.gen(function* () {
    const now = Date.parse(options.now());
    const claimedBefore = new Date(now - options.staleClaimMilliseconds).toISOString();
    yield* recoverAllStalePublicApplicationOutbox(claimedBefore);
    options.onStart?.();
    return yield* Effect.forever(tick);
  }).pipe(Effect.ensuring(Effect.sync(() => options.onStop?.())));
};
