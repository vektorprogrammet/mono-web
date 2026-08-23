import { RecruitmentInterviewId } from "@vektorprogrammet/sdk/effect";
import { Dialog } from "@foldkit/ui";
import { Schema as S } from "effect";
import { m } from "foldkit/message";
import { RecruitmentSchedulingBoardSchema } from "../recruitment/bridge";
import { SchedulingRequestId } from "./model";

export const RequestedBoardRefresh = m("RequestedBoardRefresh");
export const SucceededLoadSchedulingBoard = m("SucceededLoadSchedulingBoard", {
  requestId: SchedulingRequestId,
  board: RecruitmentSchedulingBoardSchema,
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
  board: RecruitmentSchedulingBoardSchema,
});
export const FailedSchedule = m("FailedSchedule", {
  requestId: SchedulingRequestId,
  message: S.String,
});
export const GotScheduleDialogMessage = m("GotScheduleDialogMessage", {
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
]);
export type Message = S.Schema.Type<typeof Message>;
