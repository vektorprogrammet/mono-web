import { RecruitmentInterviewId } from "@vektorprogrammet/domain/recruitment";
import { StrongETag } from "@vektorprogrammet/http-api";
import { Dialog } from "@foldkit/ui";
import { Schema as S } from "effect";
import { m } from "foldkit/message";
import {
  RecruitmentBridgeFailure,
  RecruitmentInterviewConductObservationSchema,
  SchedulingBoard,
} from "../recruitment/bridge";
import { ConductRequestId, SchedulingRequestId } from "./model";

export const RequestedBoardRefresh = m("RequestedBoardRefresh");
export const SucceededLoadSchedulingBoard = m("SucceededLoadSchedulingBoard", {
  requestId: SchedulingRequestId,
  board: SchedulingBoard,
});
export const FailedLoadSchedulingBoard = m("FailedLoadSchedulingBoard", {
  requestId: SchedulingRequestId,
  message: S.String,
});
export const OpenedSchedule = m("OpenedSchedule", { interviewId: RecruitmentInterviewId });
export const ClosedSchedule = m("ClosedSchedule");
export const UpdatedScheduledAt = m("UpdatedScheduledAt", { value: S.String });
export const UpdatedRoom = m("UpdatedRoom", { value: S.String });
export const UpdatedCampus = m("UpdatedCampus", { value: S.String });
export const UpdatedMapLink = m("UpdatedMapLink", { value: S.String });
export const UpdatedMessage = m("UpdatedMessage", { value: S.String });
export const SubmittedSchedule = m("SubmittedSchedule");
export const SucceededSchedule = m("SucceededSchedule", {
  requestId: SchedulingRequestId,
  board: SchedulingBoard,
});
export const FailedSchedule = m("FailedSchedule", {
  requestId: SchedulingRequestId,
  message: S.String,
});
export const GotScheduleDialogMessage = m("GotScheduleDialogMessage", {
  message: Dialog.Message,
});

export const OpenedConduct = m("OpenedConduct", { interviewId: RecruitmentInterviewId });
export const ClosedConduct = m("ClosedConduct");
export const SucceededConduct = m("SucceededConduct", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
  detail: RecruitmentInterviewConductObservationSchema,
  etag: StrongETag,
});
export const FailedConduct = m("FailedConduct", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
  failure: RecruitmentBridgeFailure,
});
export const ChangedAnswer = m("ChangedAnswer", {
  questionId: S.String,
  answer: S.Union([S.String, S.Array(S.String)]),
});
export const ClosedConductConfirmation = m("ClosedConductConfirmation");
export const ChangedScore = m("ChangedScore", {
  axis: S.Literals(["explanatoryPower", "roleModel", "suitability"]),
  value: S.String,
});
export const SubmittedFinalize = m("SubmittedFinalize");
export const SubmittedCancel = m("SubmittedCancel");
export const ConfirmedFinalize = m("ConfirmedFinalize");
export const ConfirmedCancel = m("ConfirmedCancel");
export const SucceededFinalize = m("SucceededFinalize", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
});
export const FailedFinalize = m("FailedFinalize", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
  failure: RecruitmentBridgeFailure,
});
export const SucceededCancel = m("SucceededCancel", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
});
export const FailedCancel = m("FailedCancel", {
  requestId: ConductRequestId,
  generation: ConductRequestId,
  interviewId: RecruitmentInterviewId,
  failure: RecruitmentBridgeFailure,
});
export const GotConductDialogMessage = m("GotConductDialogMessage", {
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
  ClosedConductConfirmation,
  SubmittedCancel,
  SubmittedFinalize,
  ConfirmedFinalize,
  ConfirmedCancel,
  SucceededFinalize,
  FailedFinalize,
  SucceededCancel,
  FailedCancel,
  GotConductDialogMessage,
]);
export type Message = S.Schema.Type<typeof Message>;
