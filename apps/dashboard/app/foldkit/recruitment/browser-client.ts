import type { RecruitmentAssignmentBoard,
RecruitmentAssignmentBoardQuery, } from "@vektorprogrammet/http-api"
import { Effect, Schema as S } from "effect";
import {
  CancelInterviewInputSchema,
  CorrectInterviewAssessmentInputSchema,
  CorrectInterviewAssessmentResponse as CorrectInterviewAssessmentResponseSchema,
  CancelInterviewResponse as CancelInterviewResponseSchema,
  CreateApplicationInterviewInputSchema,
  FinalizeInterviewInputSchema,
  FinalizeInterviewResponse as FinalizeInterviewResponseSchema,
  ReadInterviewConductInputSchema,
  RecruitmentAssignmentBoardSchema,
  RecruitmentBridgeFailure,
  RecruitmentBridgeOperationJson,
  RecruitmentInterviewConductResourceSchema,
  RecruitmentInterviewResource as RecruitmentInterviewResourceSchema,
  SchedulingBoard,
  ScheduleInterviewInputSchema,
  ScheduleInterviewResponse as ScheduleInterviewResponseSchema,
  toRecruitmentBridgeFailure,
  type RecruitmentBridgeOperation,
  type RecruitmentInterviewConductResource,
} from "./bridge";

type RecruitmentInterviewResource = S.Schema.Type<typeof RecruitmentInterviewResourceSchema>;

type ScheduleInterviewResponse = S.Schema.Type<typeof ScheduleInterviewResponseSchema>;

type FinalizeInterviewResponse = S.Schema.Type<typeof FinalizeInterviewResponseSchema>;

type CancelInterviewResponse = S.Schema.Type<typeof CancelInterviewResponseSchema>;

type CorrectInterviewAssessmentResponse = S.Schema.Type<typeof CorrectInterviewAssessmentResponseSchema>;

export type CreateApplicationInterviewInput = S.Schema.Type<
  typeof CreateApplicationInterviewInputSchema
>;

export type ScheduleInterviewInput = S.Schema.Type<typeof ScheduleInterviewInputSchema>;

export type ReadInterviewConductInput = S.Schema.Type<typeof ReadInterviewConductInputSchema>;

export type FinalizeInterviewInput = S.Schema.Type<typeof FinalizeInterviewInputSchema>;

export type CancelInterviewInput = S.Schema.Type<typeof CancelInterviewInputSchema>;

export type CorrectInterviewAssessmentInput = S.Schema.Type<typeof CorrectInterviewAssessmentInputSchema>;

interface RecruitmentOperations {
  readonly readAssignmentBoard: (
    input: Readonly<{ query: RecruitmentAssignmentBoardQuery }>,
  ) => Effect.Effect<RecruitmentAssignmentBoard, RecruitmentBridgeFailure>;
  readonly createApplicationInterview: (
    input: CreateApplicationInterviewInput,
  ) => Effect.Effect<RecruitmentInterviewResource, RecruitmentBridgeFailure>;
  readonly readSchedulingBoard: () => Effect.Effect<
    typeof SchedulingBoard.Type,
    RecruitmentBridgeFailure
  >;
  readonly scheduleInterview: (
    input: ScheduleInterviewInput,
  ) => Effect.Effect<ScheduleInterviewResponse, RecruitmentBridgeFailure>;
  readonly readInterviewConduct: (
    input: ReadInterviewConductInput,
  ) => Effect.Effect<RecruitmentInterviewConductResource, RecruitmentBridgeFailure>;
  readonly finalizeInterview: (
    input: FinalizeInterviewInput,
  ) => Effect.Effect<FinalizeInterviewResponse, RecruitmentBridgeFailure>;
  readonly cancelInterview: (
    input: CancelInterviewInput,
  ) => Effect.Effect<CancelInterviewResponse, RecruitmentBridgeFailure>;
  readonly correctInterviewAssessment: (
    input: CorrectInterviewAssessmentInput,
  ) => Effect.Effect<CorrectInterviewAssessmentResponse, RecruitmentBridgeFailure>;
}

export interface RecruitmentAssignmentClient {
  readonly recruitment: Readonly<
    Pick<RecruitmentOperations, "readAssignmentBoard" | "createApplicationInterview">
  >;
}

export interface RecruitmentClient {
  readonly recruitment: Readonly<RecruitmentOperations>;
}

const bridgeRequest = <A>(
  operation: RecruitmentBridgeOperation,
  schema: S.Decoder<A>,
): Effect.Effect<A, RecruitmentBridgeFailure> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}recruitment`, {
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

      return S.decodeUnknownSync(schema)(payload, {onExcessProperty: "error"});
    },
    catch: toRecruitmentBridgeFailure,
  });

export const createBrowserRecruitmentClient = (): RecruitmentClient => ({
  recruitment: {
    readAssignmentBoard: ({ query }) =>
      bridgeRequest({ operation: "readAssignmentBoard", query }, RecruitmentAssignmentBoardSchema,
      ),
    createApplicationInterview: ({ params, headers, payload }) =>
      bridgeRequest(
        { operation: "createApplicationInterview", params, headers, payload },
        RecruitmentInterviewResourceSchema,
      ),
    readSchedulingBoard: () =>
      bridgeRequest({ operation: "readSchedulingBoard" }, SchedulingBoard,
      ),
    scheduleInterview: ({ params, headers, payload }) =>
      bridgeRequest({ operation: "scheduleInterview", params, headers, payload }, ScheduleInterviewResponseSchema,
      ),
    readInterviewConduct: ({ params, headers }) =>
      bridgeRequest({ operation: "readInterviewConduct", params, headers }, RecruitmentInterviewConductResourceSchema,
      ),
    finalizeInterview: ({ params, headers, payload }) =>
      bridgeRequest({ operation: "finalizeInterview", params, headers, payload }, FinalizeInterviewResponseSchema,
      ),
    correctInterviewAssessment: ({ params, headers, payload }) =>
      bridgeRequest({ operation: "correctInterviewAssessment", params, headers, payload }, CorrectInterviewAssessmentResponseSchema,
      ),
    cancelInterview: ({ params, headers, payload }) =>
      bridgeRequest({ operation: "cancelInterview", params, headers, payload }, CancelInterviewResponseSchema,
      ),
  },
});
