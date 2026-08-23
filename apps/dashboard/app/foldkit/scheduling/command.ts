import {
  RecruitmentScheduleCommandSchema,
  type RecruitmentScheduleCommand,
} from "@vektorprogrammet/sdk/effect";
import { Effect } from "effect";
import { Command } from "foldkit";
import {
  schedulingBoardFailureMessage,
  schedulingFailureMessage,
  toRecruitmentBridgeFailure,
} from "../recruitment/bridge";
import type { RecruitmentSchedulingClient } from "../recruitment/browser-client";
import {
  FailedLoadSchedulingBoard,
  FailedSchedule,
  SucceededLoadSchedulingBoard,
  SucceededSchedule,
  type Message,
} from "./message";
import { SchedulingRequestId } from "./model";

export interface SchedulingCommands {
  readonly LoadSchedulingBoard: (args: {
    readonly requestId: number;
  }) => Command.Command<Message>;
  readonly ScheduleInterview: (args: {
    readonly requestId: number;
    readonly command: RecruitmentScheduleCommand;
  }) => Command.Command<Message>;
}
export const makeSchedulingCommands = (client: RecruitmentSchedulingClient): SchedulingCommands => {
  const LoadSchedulingBoard = Command.define("LoadSchedulingBoard", {
    args: { requestId: SchedulingRequestId },
    messages: [SucceededLoadSchedulingBoard, FailedLoadSchedulingBoard],
    execute: ({ requestId }) =>
      client.admin.recruitment.readSchedulingBoard().pipe(
        Effect.map((board) => SucceededLoadSchedulingBoard({ requestId, board })),
        Effect.catch((error) =>
          Effect.succeed(
            FailedLoadSchedulingBoard({
              requestId,
              message: schedulingBoardFailureMessage(toRecruitmentBridgeFailure(error)),
            }),
          ),
        ),
      ),
  });

  const ScheduleInterview = Command.define("ScheduleRecruitmentInterview", {
    args: {
      requestId: SchedulingRequestId,
      command: RecruitmentScheduleCommandSchema,
    },
    messages: [SucceededSchedule, FailedSchedule],
    execute: ({ requestId, command }) =>
      client.admin.recruitment.scheduleInterview(command).pipe(
        Effect.flatMap(() => client.admin.recruitment.readSchedulingBoard()),
        Effect.map((board) => SucceededSchedule({ requestId, board })),
        Effect.catch((error) =>
          Effect.succeed(
            FailedSchedule({
              requestId,
              message: schedulingFailureMessage(toRecruitmentBridgeFailure(error)),
            }),
          ),
        ),
      ),
  });

  return { LoadSchedulingBoard, ScheduleInterview };
};
