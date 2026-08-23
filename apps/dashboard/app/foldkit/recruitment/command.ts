import { RecruitmentAssignmentCommandSchema } from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import {
  assignmentFailureMessage,
  boardFailureMessage,
  RecruitmentBoardStatus,
  toRecruitmentBridgeFailure,
} from "./bridge";
import type { RecruitmentClient } from "./browser-client";
import {
  FailedAssignment,
  FailedLoadBoard,
  SucceededAssignment,
  SucceededLoadBoard,
  type Message,
} from "./message";
type RecruitmentAssignmentCommand = S.Schema.Type<
  typeof RecruitmentAssignmentCommandSchema
>;

export interface RecruitmentCommands {
  readonly LoadAssignmentBoard: (args: {
    readonly status: RecruitmentBoardStatus;
  }) => Command.Command<Message>;
  readonly AssignApplicant: (args: {
    readonly command: RecruitmentAssignmentCommand;
    readonly status: RecruitmentBoardStatus;
  }) => Command.Command<Message>;
}

export const makeRecruitmentCommands = (
  client: RecruitmentClient,
): RecruitmentCommands => {
  const LoadAssignmentBoard = Command.define("LoadAssignmentBoard", {
    args: { status: RecruitmentBoardStatus },
    messages: [SucceededLoadBoard, FailedLoadBoard],
    execute: ({ status }) =>
      client.admin.recruitment.readAssignmentBoard({ status }).pipe(
        Effect.map((board) => SucceededLoadBoard({ board })),
        Effect.catch((error) =>
          Effect.succeed(
            FailedLoadBoard({ message: boardFailureMessage(toRecruitmentBridgeFailure(error)) }),
          ),
        ),
      ),
  });

  const AssignApplicant = Command.define("AssignApplicant", {
    args: {
      command: RecruitmentAssignmentCommandSchema,
      status: RecruitmentBoardStatus,
    },
    messages: [SucceededAssignment, FailedAssignment],
    execute: ({ command, status }) =>
      client.admin.recruitment.assignApplicant(command).pipe(
        Effect.flatMap(() => client.admin.recruitment.readAssignmentBoard({ status })),
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

  return { LoadAssignmentBoard, AssignApplicant };
};


