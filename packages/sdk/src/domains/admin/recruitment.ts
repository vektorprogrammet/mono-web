import { Effect, Schema } from "effect";
import {
  RecruitmentAssignmentBoardSchema,
  RecruitmentAssignmentBoardQuerySchema,
  RecruitmentAssignmentCommandSchema,
  RecruitmentAssignmentResultSchema,
  type RecruitmentAssignmentBoard,
  type RecruitmentAssignmentBoardQuery,
  type RecruitmentAssignmentCommand,
  type RecruitmentAssignmentResult,
} from "../../schemas/recruitment.js";
import {
  RecruitmentDecodeError,
  type InternalSdkError,
} from "../../errors.js";
import type { Transport } from "../../transport.js";

export interface AdminRecruitmentDomain {
  readAssignmentBoard(
    query: RecruitmentAssignmentBoardQuery,
  ): Effect.Effect<RecruitmentAssignmentBoard, InternalSdkError>;
  assignApplicant(
    command: RecruitmentAssignmentCommand,
  ): Effect.Effect<RecruitmentAssignmentResult, InternalSdkError>;
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

export const createAdminRecruitmentDomain = (
  transport: Transport,
): AdminRecruitmentDomain => ({
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
});
