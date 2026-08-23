import {
  InterviewSchemaId,
  RecruitmentApplicationId,
  RecruitmentPersonId,
} from "@vektorprogrammet/sdk/effect";
import { Dialog } from "@foldkit/ui";
import { Schema as S } from "effect";
import { m } from "foldkit/message";
import { RecruitmentAssignmentBoardSchema, RecruitmentBoardStatus } from "./bridge";
import { RecruitmentBoardRequestId } from "./model";

export const SelectedFilter = m("SelectedFilter", { status: RecruitmentBoardStatus });
export const SucceededLoadBoard = m("SucceededLoadBoard", {
  requestId: RecruitmentBoardRequestId,
  board: RecruitmentAssignmentBoardSchema,
});
export const FailedLoadBoard = m("FailedLoadBoard", {
  requestId: RecruitmentBoardRequestId,
  message: S.String,
});
export const OpenedAssignment = m("OpenedAssignment", {
  applicationId: RecruitmentApplicationId,
});
export const ClosedAssignment = m("ClosedAssignment");
export const SelectedInterviewer = m("SelectedInterviewer", {
  personId: RecruitmentPersonId,
});
export const SelectedSchema = m("SelectedSchema", {
  interviewSchemaId: InterviewSchemaId,
});
export const SubmittedAssignment = m("SubmittedAssignment");
export const SucceededAssignment = m("SucceededAssignment", {
  board: RecruitmentAssignmentBoardSchema,
});
export const FailedAssignment = m("FailedAssignment", { message: S.String });
export const GotAssignmentDialogMessage = m("GotAssignmentDialogMessage", {
  message: Dialog.Message,
});

export const Message = S.Union([
  SelectedFilter,
  SucceededLoadBoard,
  FailedLoadBoard,
  OpenedAssignment,
  ClosedAssignment,
  SelectedInterviewer,
  SelectedSchema,
  SubmittedAssignment,
  SucceededAssignment,
  FailedAssignment,
  GotAssignmentDialogMessage,
]);
export type Message = S.Schema.Type<typeof Message>;
