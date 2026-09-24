import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import {
  QuestionnaireManagement,
  InterviewStaffingManagement,
  RecruitmentMaintenanceResult,
  RecruitmentInterviewQuestionKindSchema,
} from "@vektorprogrammet/http-api";

export const SelectedRecord = taggedStruct("SelectedRecord", { id: S.String });

export const ChangedName = taggedStruct("ChangedName", { value: S.String });

export const ChangedActive = taggedStruct("ChangedActive", { value: S.Boolean });

export const ChangedReason = taggedStruct("ChangedReason", { value: S.String });

export const AddedQuestion = taggedStruct("AddedQuestion", {});

export const RemovedQuestion = taggedStruct("RemovedQuestion", { index: S.Int });

export const MovedQuestion = taggedStruct("MovedQuestion", {
  index: S.Int,
  direction: S.Literals([-1, 1]),
});

export const ChangedQuestionText = taggedStruct("ChangedQuestionText", {
  index: S.Int,
  field: S.Literals(["prompt", "helpText"]),
  value: S.String,
});

export const ChangedQuestionKind = taggedStruct("ChangedQuestionKind", {
  index: S.Int,
  kind: RecruitmentInterviewQuestionKindSchema,
});

export const AddedAlternative = taggedStruct("AddedAlternative", { index: S.Int });

export const RemovedAlternative = taggedStruct("RemovedAlternative", {
  index: S.Int,
  alternative: S.Int,
});

export const MovedAlternative = taggedStruct("MovedAlternative", {
  index: S.Int,
  alternative: S.Int,
  direction: S.Literals([-1, 1]),
});

export const ChangedAlternative = taggedStruct("ChangedAlternative", {
  index: S.Int,
  alternative: S.Int,
  value: S.String,
});

export const ChangedPrimary = taggedStruct("ChangedPrimary", { value: S.String });

export const ChangedCo = taggedStruct("ChangedCo", { value: S.String });

export const SubmittedMaintenance = taggedStruct("SubmittedMaintenance", {});

export const RetriedMaintenance = taggedStruct("RetriedMaintenance", {});

export const ResumedEditing = taggedStruct("ResumedEditing", {});

export const CompletedPrepareEdit = taggedStruct("CompletedPrepareEdit", { commandId: S.String });

export const RefreshedMaintenance = taggedStruct("RefreshedMaintenance", {});

export const SucceededQuestionnaires = taggedStruct("SucceededQuestionnaires", {
  requestId: S.Int,
  data: QuestionnaireManagement,
  commandId: S.String,
});

export const SucceededStaffing = taggedStruct("SucceededStaffing", {
  requestId: S.Int,
  data: InterviewStaffingManagement,
  commandId: S.String,
});

export const FailedLoad = taggedStruct("FailedLoad", { requestId: S.Int, denied: S.Boolean });

export const SucceededSave = taggedStruct("SucceededSave", {
  commandId: S.String,
  result: RecruitmentMaintenanceResult,
});

export const FailedSave = taggedStruct("FailedSave", {
  commandId: S.String,
  message: S.String,
  conflict: S.Boolean,
});

export const Message = S.Union([
  SelectedRecord,
  ChangedName,
  ChangedActive,
  ChangedReason,
  AddedQuestion,
  RemovedQuestion,
  MovedQuestion,
  ChangedQuestionText,
  ChangedQuestionKind,
  AddedAlternative,
  RemovedAlternative,
  MovedAlternative,
  ChangedAlternative,
  ChangedPrimary,
  ChangedCo,
  SubmittedMaintenance,
  RetriedMaintenance,
  ResumedEditing,
  CompletedPrepareEdit,
  RefreshedMaintenance,
  SucceededQuestionnaires,
  SucceededStaffing,
  FailedLoad,
  SucceededSave,
  FailedSave,
]);

export type Message = typeof Message.Type;
