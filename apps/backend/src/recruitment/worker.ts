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
import { DateTime, Duration, Effect } from "effect";
import { pollForever } from "../worker-support.js";

export interface RecruitmentInvitationWorkerOptions {
  readonly workerId: string;
  readonly pollIntervalMilliseconds: number;
  readonly staleClaimMilliseconds: number;
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
    const now = yield* DateTime.now;

    const claimedBefore = DateTime.formatIso(
      DateTime.subtract(now, { milliseconds: options.staleClaimMilliseconds }),
    );

    yield* recoverStaleRecruitmentInvitations(claimedBefore);
    yield* recoverStaleRecruitmentInvitationResponses(claimedBefore);
    yield* recoverStaleRecruitmentInterviewCompletions(claimedBefore);
    yield* deliverNextRecruitmentInvitation(
      `${options.workerId}:${claimSequence++}`,
      DateTime.formatIso(yield* DateTime.now),
    );
    yield* deliverNextRecruitmentInvitationResponse(
      `${options.workerId}:response:${claimSequence++}`,
      DateTime.formatIso(yield* DateTime.now),
    );
    yield* deliverNextRecruitmentInterviewCompletion(
      `${options.workerId}:completion:${claimSequence++}`,
      DateTime.formatIso(yield* DateTime.now),
    );
  });

  return Effect.sync(() => options.onStart?.()).pipe(
    Effect.andThen(
      pollForever(tick, { interval: Duration.millis(options.pollIntervalMilliseconds) }),
    ),
    Effect.ensuring(Effect.sync(() => options.onStop?.())),
  );
};
