import {
  deliverNextRecruitmentInterviewCompletion,
  deliverNextRecruitmentInvitation,
  deliverNextRecruitmentInvitationResponse,
  recoverStaleRecruitmentInterviewCompletions,
  recoverStaleRecruitmentInvitationResponses,
  recoverStaleRecruitmentInvitations,
} from "@vektorprogrammet/database/recruitment";
import { Database } from "@vektorprogrammet/database";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import { NotificationGateway } from "@vektorprogrammet/domain/notification";
import { Profile } from "@vektorprogrammet/domain/profile";
import { RecruitmentPersistenceError } from "@vektorprogrammet/domain/recruitment";
import { Duration, Effect } from "effect";

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
  RecruitmentPersistenceError,
  Admissions | Database | NotificationGateway | Profile
> => {
  positiveInteger(options.pollIntervalMilliseconds, "poll interval");
  positiveInteger(options.staleClaimMilliseconds, "stale claim interval");
  let claimSequence = 0;
  const tick = Effect.gen(function* () {
    const now = options.now();
    const claimedBefore = new Date(Date.parse(now) - options.staleClaimMilliseconds).toISOString();
    yield* recoverStaleRecruitmentInvitations(claimedBefore);
    yield* recoverStaleRecruitmentInvitationResponses(claimedBefore);
    yield* recoverStaleRecruitmentInterviewCompletions(claimedBefore);
    yield* deliverNextRecruitmentInvitation(`${options.workerId}:${claimSequence++}`, now);
    yield* deliverNextRecruitmentInvitationResponse(
      `${options.workerId}:response:${claimSequence++}`,
      now,
    );
    yield* deliverNextRecruitmentInterviewCompletion(
      `${options.workerId}:completion:${claimSequence++}`,
      now,
    );
    yield* Effect.sleep(Duration.millis(options.pollIntervalMilliseconds));
  });
  return Effect.sync(() => options.onStart?.()).pipe(
    Effect.andThen(Effect.forever(tick)),
    Effect.ensuring(Effect.sync(() => options.onStop?.())),
  );
};
