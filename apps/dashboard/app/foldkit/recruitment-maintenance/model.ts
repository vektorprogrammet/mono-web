import { Schema as S } from "effect";
import { Dialog } from "@foldkit/ui";
import {
  RecruitmentMaintenanceCommand,
  QuestionnaireManagement,
  InterviewStaffingManagement,
  RecruitmentInterviewQuestionKindSchema,
} from "@vektorprogrammet/http-api";

export const Mode = S.Literals(["Questionnaires", "Staffing"]);

export type Mode = typeof Mode.Type;

export const CorrectionWindowAction = S.Literals(["Reopen", "Close"]);

export const WorkflowFocusTicket = S.Struct({
  interviewId: S.String,
  requestId: S.Int,
  commandId: S.String,
});

export type WorkflowFocusTicket = typeof WorkflowFocusTicket.Type;

export const WorkflowFocusIntent = S.Struct({
  ticket: WorkflowFocusTicket,
  phase: S.Literals(["Reloading", "Closing", "Focusing"]),
});

export const DraftQuestion = S.Struct({
  questionId: S.String,
  prompt: S.String,
  helpText: S.String,
  kind: RecruitmentInterviewQuestionKindSchema,
  alternatives: S.Array(S.String),
});

export const QuestionnaireDraft = S.Struct({
  name: S.String,
  active: S.Boolean,
  questions: S.Array(DraftQuestion),
});

export const Mutation = S.TaggedUnion({
  Idle: {},
  Pending: { command: RecruitmentMaintenanceCommand },
  Failed: { command: RecruitmentMaintenanceCommand, message: S.String },
  Conflict: { message: S.String },
  Invalid: { message: S.String },
  Saved: {},
});

export const Model = S.Struct({
  mode: Mode,
  status: S.Literals(["Loading", "Ready", "Failed", "Denied"]),
  questionnaires: S.NullOr(QuestionnaireManagement),
  staffing: S.NullOr(InterviewStaffingManagement),
  selectedId: S.String,
  expectedRevision: S.Int,
  draft: QuestionnaireDraft,
  primary: S.String,
  co: S.String,
  reason: S.String,
  correctionDialog: Dialog.Model,
  dialogGeneration: S.Int,
  dialogClosing: S.Boolean,
  closingTicket: S.NullOr(WorkflowFocusTicket),
  workflowFocus: S.NullOr(WorkflowFocusIntent),
  cancellingFocus: S.NullOr(WorkflowFocusTicket),
  reloadAfterCancel: S.NullOr(S.Int),
  correctionAction: S.NullOr(CorrectionWindowAction),
  correctionReason: S.String,
  correctionEndsAt: S.String,
  correctionSequence: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  nextQuestion: S.Int,
  commandId: S.String,
  mutation: Mutation,
  requestId: S.Int,
});

export type Model = typeof Model.Type;

export const init = (mode: Mode): Model => ({
  mode,
  status: "Loading",
  questionnaires: null,
  staffing: null,
  selectedId: "",
  expectedRevision: 0,
  draft: { name: "", active: false, questions: [] },
  primary: "",
  co: "",
  reason: "",
  correctionDialog: Dialog.init({ id: "recruitment-correction-window" }),
  dialogGeneration: 0,
  dialogClosing: false,
  closingTicket: null,
  workflowFocus: null,
  cancellingFocus: null,
  reloadAfterCancel: null,
  correctionAction: null,
  correctionReason: "",
  correctionEndsAt: "",
  correctionSequence: 0,
  nextQuestion: 0,
  commandId: "",
  mutation: Mutation.cases.Idle.make({}),
  requestId: 1,
});
