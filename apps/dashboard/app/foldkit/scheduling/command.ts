import { RecruitmentInterviewId } from "@vektorprogrammet/domain/recruitment";
import { Effect } from "effect";
import { Command } from "foldkit";
import type {
  CancelInterviewInput,
  FinalizeInterviewInput,
  RecruitmentClient,
  ScheduleInterviewInput,
} from "../recruitment/browser-client";
import {
  CancelInterviewInputSchema,
  FinalizeInterviewInputSchema,
  ScheduleInterviewInputSchema,
  schedulingBoardFailureMessage,
  schedulingFailureMessage,
  toRecruitmentBridgeFailure,
} from "../recruitment/bridge";
import {
  FailedCancel,
  FailedConduct,
  FailedFinalize,
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
    readonly input: ScheduleInterviewInput;
  }) => Command.Command<Message>;
  readonly ReadInterviewConduct: (args: {
    readonly requestId: number;
    readonly generation: number;
    readonly interviewId: typeof RecruitmentInterviewId.Type;
  }) => Command.Command<Message>;
  readonly FinalizeInterview: (args: {
    readonly requestId: number;
    readonly generation: number;
    readonly interviewId: typeof RecruitmentInterviewId.Type;
    readonly input: FinalizeInterviewInput;
  }) => Command.Command<Message>;
  readonly CancelInterview: (args: {
    readonly requestId: number;
    readonly generation: number;
    readonly interviewId: typeof RecruitmentInterviewId.Type;
    readonly input: CancelInterviewInput;
  }) => Command.Command<Message>;
}

export const makeSchedulingCommands = (client: RecruitmentClient): SchedulingCommands => {
  const LoadSchedulingBoard = Command.define("LoadSchedulingBoard", {
    args: { requestId: SchedulingRequestId },
    messages: [SucceededLoadSchedulingBoard, FailedLoadSchedulingBoard],
    execute: ({ requestId }) =>
      client.recruitment.readSchedulingBoard().pipe(
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

  const ScheduleInterview = Command.define("ScheduleInterview", {
    args: {
      requestId: SchedulingRequestId,
      input: ScheduleInterviewInputSchema,
    },
    messages: [SucceededSchedule, FailedSchedule],
    execute: ({ requestId, input }) =>
      client.recruitment.scheduleInterview(input).pipe(
        Effect.flatMap(() => client.recruitment.readSchedulingBoard()),
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
      client.recruitment.readInterviewConduct({ params: { interviewId }, headers: {} }).pipe(
        Effect.map(({ detail, etag }) =>
          SucceededConduct({ requestId, generation, interviewId, detail, etag }),
        ),
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
      input: FinalizeInterviewInputSchema,
    },
    messages: [SucceededFinalize, FailedFinalize],
    execute: ({ requestId, generation, interviewId, input }) =>
      client.recruitment.finalizeInterview(input).pipe(
        Effect.map(() => SucceededFinalize({ requestId, generation, interviewId })),
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
      input: CancelInterviewInputSchema,
    },
    messages: [SucceededCancel, FailedCancel],
    execute: ({ requestId, generation, interviewId, input }) =>
      client.recruitment.cancelInterview(input).pipe(
        Effect.map(() => SucceededCancel({ requestId, generation, interviewId })),
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
