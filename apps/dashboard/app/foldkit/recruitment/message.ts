import { PublicApplicationIdSchema } from "@vektorprogrammet/http-api"
import { InterviewSchemaId,
RecruitmentInterviewerOptionSchema, } from "@vektorprogrammet/http-api"
import { Dialog } from "@foldkit/ui";
import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import { RecruitmentAssignmentBoardSchema, RecruitmentBoardStatus } from "./bridge";
import { RecruitmentBoardRequestId } from "./model";

export const SelectedFilter = taggedStruct("SelectedFilter", { status: RecruitmentBoardStatus });

export const SucceededLoadBoard = taggedStruct("SucceededLoadBoard", {
  requestId: RecruitmentBoardRequestId,
  board: RecruitmentAssignmentBoardSchema,
});

export const FailedLoadBoard = taggedStruct("FailedLoadBoard", {
  requestId: RecruitmentBoardRequestId,
  message: S.String,
});

export const OpenedAssignment = taggedStruct("OpenedAssignment", {
  applicationId: PublicApplicationIdSchema,
});

export const ClosedAssignment = taggedStruct("ClosedAssignment", {});

export const SelectedInterviewer = taggedStruct("SelectedInterviewer", {
  personId: RecruitmentInterviewerOptionSchema.fields.personId,
});

export const SelectedSchema = taggedStruct("SelectedSchema", {
  interviewSchemaId: InterviewSchemaId,
});

export const SubmittedAssignment = taggedStruct("SubmittedAssignment", {});

export const SucceededAssignment = taggedStruct("SucceededAssignment", {
  board: RecruitmentAssignmentBoardSchema,
});

export const FailedAssignment = taggedStruct("FailedAssignment", { message: S.String });

export const GotAssignmentDialogMessage = taggedStruct("GotAssignmentDialogMessage", {
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
