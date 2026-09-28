import { Effect } from "effect";
import { dual } from "effect/Function";
import { compareRfc3339Instants } from "../time.js";
import { RecruitmentInterviewAlreadyScheduled, RecruitmentScheduleInPast } from "./errors.js";
import type { RecruitmentInvitationResponseState, RecruitmentScheduleCommand } from "./schema.js";

/** Initial scheduling and applicant-requested replacement share one command. */
export const validateInterviewScheduling: {
  (
    current: {
      readonly scheduled: boolean;
      readonly responseState: RecruitmentInvitationResponseState | null;
      readonly completed: boolean;
      readonly cancelled: boolean;
    },
    now: string,
  ): (
    command: RecruitmentScheduleCommand,
  ) => Effect.Effect<void, RecruitmentInterviewAlreadyScheduled | RecruitmentScheduleInPast>;
  (
    command: RecruitmentScheduleCommand,
    current: {
      readonly scheduled: boolean;
      readonly responseState: RecruitmentInvitationResponseState | null;
      readonly completed: boolean;
      readonly cancelled: boolean;
    },
    now: string,
  ): Effect.Effect<void, RecruitmentInterviewAlreadyScheduled | RecruitmentScheduleInPast>;
} = dual(
  3,
  (
    command: RecruitmentScheduleCommand,
    current: {
      readonly scheduled: boolean;
      readonly responseState: RecruitmentInvitationResponseState | null;
      readonly completed: boolean;
      readonly cancelled: boolean;
    },
    now: string,
  ): Effect.Effect<void, RecruitmentInterviewAlreadyScheduled | RecruitmentScheduleInPast> => {
    if (
      current.completed ||
      current.cancelled ||
      (current.scheduled && current.responseState !== "RequestedNewTime")
    ) {
      return Effect.fail(
        RecruitmentInterviewAlreadyScheduled.make({ interviewId: command.interviewId }),
      );
    }

    if (compareRfc3339Instants(command.scheduledAt, now) <= 0) {
      return Effect.fail(RecruitmentScheduleInPast.make({ interviewId: command.interviewId }));
    }

    return Effect.void;
  },
);
