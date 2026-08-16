import { Schema as S } from "effect"
import { AsyncData, FieldValidation } from "foldkit"
import { AssignedInterview, CandidateInterviewView } from "@vektorprogrammet/sdk/effect"

export const InterviewsData = AsyncData.Schema(S.Array(AssignedInterview), S.String)
export const CandidateData = AsyncData.Schema(CandidateInterviewView, S.String)

const StringField = FieldValidation.Field(S.String)

export const Model = S.Struct({
  mode: S.Literals(["dashboard", "candidate"]),
  departmentId: S.String,
  semesterId: S.String,
  departmentValidation: StringField,
  semesterValidation: StringField,
  interviews: InterviewsData.schema,
  selectedInterviewId: S.NullOr(S.String),
  interviewTime: StringField,
  room: StringField,
  campus: StringField,
  candidate: CandidateData.schema,
  feedback: S.NullOr(S.String),
  isScheduling: S.Boolean,
  isAccepting: S.Boolean,
})
export type Model = S.Schema.Type<typeof Model>

export const makeInitialModel = (
  mode: S.Schema.Type<typeof Model>["mode"],
): Model => ({
  mode,
  departmentId: "",
  semesterId: "",
  departmentValidation: FieldValidation.NotValidated({ value: "" }),
  semesterValidation: FieldValidation.NotValidated({ value: "" }),
  interviews: AsyncData.Idle(),
  selectedInterviewId: null,
  interviewTime: FieldValidation.NotValidated({ value: "" }),
  room: FieldValidation.NotValidated({ value: "" }),
  campus: FieldValidation.NotValidated({ value: "" }),
  candidate: AsyncData.Idle(),
  feedback: null,
  isScheduling: false,
  isAccepting: false,
})
