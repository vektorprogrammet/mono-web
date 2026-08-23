import { Database } from "../database/service.js";
import { NotificationGateway } from "../notification/service.js";
import { Duration, Effect } from "effect";
import { RecruitmentDecodeError, RecruitmentPersistenceError } from "./errors.js";
import {
  deliverNextRecruitmentInvitation,
  recoverStaleRecruitmentInvitations,
} from "./outbox.js";

export interface RecruitmentInvitationWorkerOptions {
  readonly workerId: string;
  readonly pollIntervalMilliseconds: number;
  readonly staleClaimMilliseconds: number;
  readonly now: () => string;
  readonly onStart?: () => void;
  readonly onStop?: () => void;
}

const positiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
};

export const runRecruitmentInvitationWorker = (
  options: RecruitmentInvitationWorkerOptions,
): Effect.Effect<
  never,
  RecruitmentPersistenceError | RecruitmentDecodeError,
  Database | NotificationGateway
> => {
  positiveInteger(options.pollIntervalMilliseconds, "poll interval");
  positiveInteger(options.staleClaimMilliseconds, "stale claim interval");
  let claimSequence = 0;
  const tick = Effect.gen(function* () {
    const now = options.now();
    const claimedBefore = new Date(
      Date.parse(now) - options.staleClaimMilliseconds,
    ).toISOString();
    yield* recoverStaleRecruitmentInvitations(claimedBefore);
    yield* deliverNextRecruitmentInvitation(
      `${options.workerId}:${claimSequence++}`,
      now,
    );
    yield* Effect.sleep(Duration.millis(options.pollIntervalMilliseconds));
  });
  return Effect.sync(() => options.onStart?.()).pipe(
    Effect.andThen(Effect.forever(tick)),
    Effect.ensuring(Effect.sync(() => options.onStop?.())),
  );
};
