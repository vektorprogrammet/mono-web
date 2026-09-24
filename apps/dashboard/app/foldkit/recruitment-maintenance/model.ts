import { Schema as S } from "effect";
import {
  RecruitmentMaintenanceCommand,
  QuestionnaireManagement,
  InterviewStaffingManagement,
  RecruitmentInterviewQuestionKindSchema,
} from "@vektorprogrammet/http-api";

export const Mode = S.Literals(["Questionnaires", "Staffing"]);

export type Mode = typeof Mode.Type;

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
  nextQuestion: 0,
  commandId: "",
  mutation: Mutation.cases.Idle.make({}),
  requestId: 1,
});
