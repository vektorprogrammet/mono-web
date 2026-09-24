import { InterviewRecommendationSchema } from "@vektorprogrammet/http-api"
import { RecruitmentInterviewId } from "@vektorprogrammet/http-api"
import { StrongETag } from "@vektorprogrammet/http-api";
import { Dialog } from "@foldkit/ui";
import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import {
  RecruitmentBridgeFailure,
  RecruitmentInterviewConductObservationSchema,
  SchedulingBoard,
} from "../recruitment/bridge";
import { ConductRequestId, SchedulingRequestId } from "./model";

export const RequestedBoardRefresh = taggedStruct("RequestedBoardRefresh", {});

export const SucceededLoadSchedulingBoard = taggedStruct("SucceededLoadSchedulingBoard", {
  requestId: SchedulingRequestId,
  board: SchedulingBoard,
});

export const FailedLoadSchedulingBoard = taggedStruct("FailedLoadSchedulingBoard", {
  requestId: SchedulingRequestId,
  message: S.String,
});

export const OpenedSchedule = taggedStruct("OpenedSchedule", { interviewId: RecruitmentInterviewId });

export const ClosedSchedule = taggedStruct("ClosedSchedule", {});

export const UpdatedScheduledAt = taggedStruct("UpdatedScheduledAt", { value: S.String });

export const UpdatedRoom = taggedStruct("UpdatedRoom", { value: S.String });

export const UpdatedCampus = taggedStruct("UpdatedCampus", { value: S.String });

export const UpdatedMapLink = taggedStruct("UpdatedMapLink", { value: S.String });

export const UpdatedMessage = taggedStruct("UpdatedMessage", { value: S.String });

export const SubmittedSchedule = taggedStruct("SubmittedSchedule", {});

export const SucceededSchedule = taggedStruct("SucceededSchedule", {
  requestId: SchedulingRequestId,
  board: SchedulingBoard,
});

export const FailedSchedule = taggedStruct("FailedSchedule", {
  requestId: SchedulingRequestId,
  failure: RecruitmentBridgeFailure,
  outcome: S.Literals(["Rejected", "Unknown", "Committed"]),
});

export const GotScheduleDialogMessage = taggedStruct("GotScheduleDialogMessage", {
  message: Dialog.Message,
});

export const OpenedConduct = taggedStruct("OpenedConduct", { interviewId: RecruitmentInterviewId });

export const ClosedConduct = taggedStruct("ClosedConduct", {});

export const SucceededConduct = taggedStruct("SucceededConduct", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
  detail: RecruitmentInterviewConductObservationSchema,
  etag: StrongETag,
});

export const FailedConduct = taggedStruct("FailedConduct", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
  failure: RecruitmentBridgeFailure,
});

export const ChangedAnswer = taggedStruct("ChangedAnswer", {
  questionId: S.String,
  answer: S.Union([S.String, S.Array(S.String)]),
});

export const ClosedConductConfirmation = taggedStruct("ClosedConductConfirmation", {});

export const ChangedRecommendation = taggedStruct("ChangedRecommendation", {
  value: S.NullOr(InterviewRecommendationSchema),
});

export const ChangedScore = taggedStruct("ChangedScore", {
  axis: S.Literals(["explanatoryPower", "roleModel", "suitability"]),
  value: S.String,
});

export const SubmittedFinalize = taggedStruct("SubmittedFinalize", {});

export const SubmittedCancel = taggedStruct("SubmittedCancel", {});

export const ConfirmedFinalize = taggedStruct("ConfirmedFinalize", {});

export const ConfirmedCancel = taggedStruct("ConfirmedCancel", {});

export const SucceededFinalize = taggedStruct("SucceededFinalize", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
});

export const SucceededCorrection = taggedStruct("SucceededCorrection", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
});

export const FailedCorrection = taggedStruct("FailedCorrection", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
  failure: RecruitmentBridgeFailure,
});

export const FailedFinalize = taggedStruct("FailedFinalize", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
  failure: RecruitmentBridgeFailure,
});

export const SucceededCancel = taggedStruct("SucceededCancel", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
});

export const FailedCancel = taggedStruct("FailedCancel", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
  failure: RecruitmentBridgeFailure,
});

export const GotConductDialogMessage = taggedStruct("GotConductDialogMessage", {
  message: Dialog.Message,
});

export const Message = S.Union([
  RequestedBoardRefresh,
  SucceededLoadSchedulingBoard,
  FailedLoadSchedulingBoard,
  OpenedSchedule,
  ClosedSchedule,
  UpdatedScheduledAt,
  UpdatedRoom,
  UpdatedCampus,
  UpdatedMapLink,
  UpdatedMessage,
  SubmittedSchedule,
  SucceededSchedule,
  FailedSchedule,
  GotScheduleDialogMessage,
  OpenedConduct,
  ClosedConduct,
  SucceededConduct,
  FailedConduct,
  ChangedAnswer,
  ChangedScore,
  ChangedRecommendation,
  ClosedConductConfirmation,
  SubmittedCancel,
  SubmittedFinalize,
  ConfirmedFinalize,
  ConfirmedCancel,
  SucceededFinalize,
  SucceededCorrection,
  FailedFinalize,
  FailedCorrection,
  SucceededCancel,
  FailedCancel,
  GotConductDialogMessage,
]);

export type Message = S.Schema.Type<typeof Message>;
