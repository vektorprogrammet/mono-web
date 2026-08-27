import {
  RecruitmentInterviewId,
  RecruitmentScheduleCommandSchema,
} from "@vektorprogrammet/sdk/effect";
import {
  CancelInterviewCommandSchema,
  FinalizeInterviewCommandSchema,
} from "@vektorprogrammet/sdk";
import type {
  CancelInterviewCommand,
  FinalizeInterviewCommand,
  RecruitmentScheduleCommand,
} from "@vektorprogrammet/sdk";
import { Effect } from "effect";
import { Command } from "foldkit";
import {
  schedulingBoardFailureMessage,
  schedulingFailureMessage,
  toRecruitmentBridgeFailure,
} from "../recruitment/bridge";
import type { RecruitmentClient } from "../recruitment/browser-client";
import {
  FailedConduct,
  FailedFinalize,
  FailedCancel,
  FailedLoadSchedulingBoard,
  FailedSchedule,
  SucceededCancel,
  SucceededConduct,
  SucceededFinalize,
  SucceededLoadSchedulingBoard,
  SucceededSchedule,
  type Message,
} from "./message";
import { ConductRequestId, SchedulingRequestId } from "./model";

export interface SchedulingCommands {
  readonly LoadSchedulingBoard: (args: { readonly requestId: number }) => Command.Command<Message>;
  readonly ScheduleInterview: (args: {
    readonly requestId: number;
    readonly command: RecruitmentScheduleCommand;
  }) => Command.Command<Message>;
  readonly ReadInterviewConduct: (args: {
    readonly requestId: number;
    readonly generation: number;
    readonly interviewId: RecruitmentInterviewId;
  }) => Command.Command<Message>;
  readonly FinalizeInterview: (args: {
    readonly requestId: number;
    readonly generation: number;
    readonly interviewId: RecruitmentInterviewId;
    readonly command: FinalizeInterviewCommand;
  }) => Command.Command<Message>;
  readonly CancelInterview: (args: {
    readonly requestId: number;
    readonly generation: number;
    readonly interviewId: RecruitmentInterviewId;
    readonly command: CancelInterviewCommand;
  }) => Command.Command<Message>;
}

export const makeSchedulingCommands = (client: RecruitmentClient): SchedulingCommands => {
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

  const ReadInterviewConduct = Command.define("ReadInterviewConduct", {
    args: {
      requestId: ConductRequestId,
      generation: ConductRequestId,
      interviewId: RecruitmentInterviewId,
    },
    messages: [SucceededConduct, FailedConduct],
    execute: ({ requestId, generation, interviewId }) =>
      client.admin.recruitment.readInterviewConduct(interviewId).pipe(
        Effect.map((detail) => SucceededConduct({ requestId, generation, interviewId, detail })),
        Effect.catch((error) =>
          Effect.succeed(
            FailedConduct({
              requestId,
              generation,
              interviewId,
              failure: toRecruitmentBridgeFailure(error),
            }),
          ),
        ),
      ),
  });

  const FinalizeInterview = Command.define("FinalizeInterview", {
    args: {
      requestId: ConductRequestId,
      generation: ConductRequestId,
      interviewId: RecruitmentInterviewId,
      command: FinalizeInterviewCommandSchema,
    },
    messages: [SucceededFinalize, FailedFinalize],
    execute: ({ requestId, generation, interviewId, command }) =>
      client.admin.recruitment.finalizeInterview(command).pipe(
        Effect.map((result) => SucceededFinalize({ requestId, generation, interviewId, result })),
        Effect.catch((error) =>
          Effect.succeed(
            FailedFinalize({
              requestId,
              generation,
              interviewId,
              failure: toRecruitmentBridgeFailure(error),
            }),
          ),
        ),
      ),
  });

  const CancelInterview = Command.define("CancelInterview", {
    args: {
      requestId: ConductRequestId,
      generation: ConductRequestId,
      interviewId: RecruitmentInterviewId,
      command: CancelInterviewCommandSchema,
    },
    messages: [SucceededCancel, FailedCancel],
    execute: ({ requestId, generation, interviewId, command }) =>
      client.admin.recruitment.cancelInterview(command).pipe(
        Effect.map((result) => SucceededCancel({ requestId, generation, interviewId, result })),
        Effect.catch((error) =>
          Effect.succeed(
            FailedCancel({
              requestId,
              generation,
              interviewId,
              failure: toRecruitmentBridgeFailure(error),
            }),
          ),
        ),
      ),
  });

  return {
    LoadSchedulingBoard,
    ScheduleInterview,
    ReadInterviewConduct,
    FinalizeInterview,
    CancelInterview,
  };
};
