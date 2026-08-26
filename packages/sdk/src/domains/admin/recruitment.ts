import { Effect, Schema } from "effect";
import {
  RecruitmentAssignmentBoardSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentAssignmentResultSchema,
  RecruitmentScheduleCommandSchema,
  RecruitmentScheduleResultSchema,
  RecruitmentSchedulingBoardSchema,
  type RecruitmentAssignmentBoard,
  type RecruitmentAssignmentBoardQuery,
  type RecruitmentAssignmentCommand,
  type RecruitmentAssignmentResult,
  type RecruitmentScheduleCommand,
  type RecruitmentScheduleResult,
  type RecruitmentSchedulingBoard,
} from "../../schemas/recruitment.js";
import { RecruitmentDecodeError, type InternalSdkError } from "../../errors.js";
import type { Transport } from "../../transport.js";

export interface AdminRecruitmentDomain {
  readAssignmentBoard(
    query: RecruitmentAssignmentBoardQuery,
  ): Effect.Effect<RecruitmentAssignmentBoard, InternalSdkError>;
  assignApplicant(
    command: RecruitmentAssignmentCommand,
  ): Effect.Effect<RecruitmentAssignmentResult, InternalSdkError>;
  readSchedulingBoard(): Effect.Effect<RecruitmentSchedulingBoard, InternalSdkError>;
  scheduleInterview(
    command: RecruitmentScheduleCommand,
  ): Effect.Effect<RecruitmentScheduleResult, InternalSdkError>;
}

const strictRecruitment = {
  strict: true,
  errorFamily: "recruitment" as const,
  decodeError: () => new RecruitmentDecodeError(),
};

const decodeQuery = (
  query: unknown,
): Effect.Effect<RecruitmentAssignmentBoardQuery, RecruitmentDecodeError> =>
  Schema.decodeUnknownEffect(RecruitmentAssignmentBoardQuerySchema)(query, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new RecruitmentDecodeError()));

const decodeCommand = (
  command: unknown,
): Effect.Effect<RecruitmentAssignmentCommand, RecruitmentDecodeError> =>
  Schema.decodeUnknownEffect(RecruitmentAssignmentCommandSchema)(command, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new RecruitmentDecodeError()));

const decodeScheduleCommand = (
  command: unknown,
): Effect.Effect<RecruitmentScheduleCommand, RecruitmentDecodeError> =>
  Schema.decodeUnknownEffect(RecruitmentScheduleCommandSchema)(command, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new RecruitmentDecodeError()));

export const createAdminRecruitmentDomain = (transport: Transport): AdminRecruitmentDomain => ({
  readAssignmentBoard(query) {
    return decodeQuery(query).pipe(
      Effect.flatMap((validQuery) =>
        transport.get(
          "/api/admin/recruitment/assignment-board",
          RecruitmentAssignmentBoardSchema,
          { status: validQuery.status },
          strictRecruitment,
        ),
      ),
    );
  },

  assignApplicant(command) {
    return decodeCommand(command).pipe(
      Effect.flatMap((validCommand) =>
        transport.post(
          "/api/admin/recruitment/interviews/assign",
          validCommand,
          RecruitmentAssignmentResultSchema,
          strictRecruitment,
        ),
      ),
    );
  },

  readSchedulingBoard() {
    return transport.get(
      "/api/admin/recruitment/interviews/scheduling-board",
      RecruitmentSchedulingBoardSchema,
      undefined,
      strictRecruitment,
    );
  },

  scheduleInterview(command) {
    return decodeScheduleCommand(command).pipe(
      Effect.flatMap((validCommand) =>
        transport.post(
          "/api/admin/recruitment/interviews/schedule",
          validCommand,
          RecruitmentScheduleResultSchema,
          strictRecruitment,
        ),
      ),
    );
  },
});
