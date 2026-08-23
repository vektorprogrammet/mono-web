import type {
  RecruitmentAssignmentBoard,
  RecruitmentAssignmentBoardQuery,
  RecruitmentAssignmentCommand,
  RecruitmentAssignmentResult,
  RecruitmentScheduleCommand,
  RecruitmentScheduleResult,
  RecruitmentSchedulingBoard,
} from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import {
  RecruitmentAssignmentBoardSchema,
  RecruitmentAssignmentResultSchema,
  RecruitmentScheduleResultSchema,
  RecruitmentSchedulingBoardSchema,
  RecruitmentBridgeFailure,
  RecruitmentBridgeOperationJson,
  toRecruitmentBridgeFailure,
  type RecruitmentBridgeOperation,
} from "./bridge";

interface RecruitmentAssignmentOperations {
  readonly readAssignmentBoard: (
    query: RecruitmentAssignmentBoardQuery,
  ) => Effect.Effect<RecruitmentAssignmentBoard, RecruitmentBridgeFailure>;
  readonly assignApplicant: (
    command: RecruitmentAssignmentCommand,
  ) => Effect.Effect<RecruitmentAssignmentResult, RecruitmentBridgeFailure>;
}

interface RecruitmentSchedulingOperations {
  readonly readSchedulingBoard: () => Effect.Effect<
    RecruitmentSchedulingBoard,
    RecruitmentBridgeFailure
  >;
  readonly scheduleInterview: (
    command: RecruitmentScheduleCommand,
  ) => Effect.Effect<RecruitmentScheduleResult, RecruitmentBridgeFailure>;
}

export interface RecruitmentAssignmentClient {
  readonly admin: Readonly<{
    recruitment: Readonly<RecruitmentAssignmentOperations>;
  }>;
}

export interface RecruitmentSchedulingClient {
  readonly admin: Readonly<{
    recruitment: Readonly<RecruitmentSchedulingOperations>;
  }>;
}

export interface RecruitmentClient {
  readonly admin: Readonly<{
    recruitment: Readonly<RecruitmentAssignmentOperations & RecruitmentSchedulingOperations>;
  }>;
}

const bridgeRequest = <A>(
  operation: RecruitmentBridgeOperation,
  decode: (value: unknown) => A,
): Effect.Effect<A, RecruitmentBridgeFailure> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch("/recruitment", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: S.encodeSync(RecruitmentBridgeOperationJson)(operation),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw S.decodeUnknownSync(RecruitmentBridgeFailure)(payload, {
          onExcessProperty: "error",
        });
      }
      return decode(payload);
    },
    catch: toRecruitmentBridgeFailure,
  });

export const createBrowserRecruitmentClient = (): RecruitmentClient => ({
  admin: {
    recruitment: {
      readAssignmentBoard: (query) =>
        bridgeRequest(
          { operation: "readAssignmentBoard", query },
          (value) =>
            S.decodeUnknownSync(RecruitmentAssignmentBoardSchema)(value, {
              onExcessProperty: "error",
            }),
        ),
      assignApplicant: (command) =>
        bridgeRequest(
          { operation: "assignApplicant", command },
          (value) =>
            S.decodeUnknownSync(RecruitmentAssignmentResultSchema)(value, {
              onExcessProperty: "error",
            }),
        ),
      readSchedulingBoard: () =>
        bridgeRequest(
          { operation: "readSchedulingBoard" },
          (value) =>
            S.decodeUnknownSync(RecruitmentSchedulingBoardSchema)(value, {
              onExcessProperty: "error",
            }),
        ),
      scheduleInterview: (command) =>
        bridgeRequest(
          { operation: "scheduleInterview", command },
          (value) =>
            S.decodeUnknownSync(RecruitmentScheduleResultSchema)(value, {
              onExcessProperty: "error",
            }),
        ),
    },
  },
});
