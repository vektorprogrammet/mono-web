import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import {
  assignmentFailureMessage,
  boardFailureMessage,
  CreateApplicationInterviewInputSchema,
  RecruitmentBoardStatus,
  toRecruitmentBridgeFailure,
} from "./bridge";
import type {
  CreateApplicationInterviewInput,
  RecruitmentAssignmentClient,
} from "./browser-client";
import {
  FailedAssignment,
  FailedLoadBoard,
  SucceededAssignment,
  SucceededLoadBoard,
  type Message,
} from "./message";

export interface RecruitmentCommands {
  readonly LoadAssignmentBoard: (args: {
    readonly status: RecruitmentBoardStatus;
    readonly requestId: number;
  }) => Command.Command<Message>;
  readonly CreateApplicationInterview: (args: {
    readonly input: CreateApplicationInterviewInput;
    readonly status: RecruitmentBoardStatus;
  }) => Command.Command<Message>;
}

export const makeRecruitmentCommands = (
  client: RecruitmentAssignmentClient,
): RecruitmentCommands => {
  const LoadAssignmentBoard = Command.define("LoadAssignmentBoard", {
    args: { status: RecruitmentBoardStatus, requestId: S.Int },
    messages: [SucceededLoadBoard, FailedLoadBoard],
    execute: ({ status, requestId }) =>
      client.recruitment.readAssignmentBoard({ query: { status } }).pipe(
        Effect.map((board) => SucceededLoadBoard({ requestId, board })),
        Effect.catch((error) =>
          Effect.succeed(
            FailedLoadBoard({
              requestId,
              message: boardFailureMessage(toRecruitmentBridgeFailure(error)),
            }),
          ),
        ),
      ),
  });

  const CreateApplicationInterview = Command.define("CreateApplicationInterview", {
    args: {
      input: CreateApplicationInterviewInputSchema,
      status: RecruitmentBoardStatus,
    },
    messages: [SucceededAssignment, FailedAssignment],
    execute: ({ input, status }) =>
      client.recruitment.createApplicationInterview(input).pipe(
        Effect.flatMap(() => client.recruitment.readAssignmentBoard({ query: { status } })),
        Effect.map((board) => SucceededAssignment({ board })),
        Effect.catch((error) =>
          Effect.succeed(
            FailedAssignment({
              message: assignmentFailureMessage(toRecruitmentBridgeFailure(error)),
            }),
          ),
        ),
      ),
  });

  return { LoadAssignmentBoard, CreateApplicationInterview };
};
