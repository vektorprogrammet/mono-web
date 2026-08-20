import { Schema as S } from "effect"
import { AsyncData, FieldValidation } from "foldkit"
import {
  CandidateInterviewView,
  Interview,
  InterviewId,
} from "@vektorprogrammet/sdk/effect"

export const InterviewsData = AsyncData.Schema(S.Array(Interview), S.String)
export const CandidateData = AsyncData.Schema(CandidateInterviewView, S.String)

const StringField = FieldValidation.Field(S.String)

export const Model = S.Struct({
  mode: S.Literals(["dashboard", "candidate"]),
  interviews: InterviewsData.schema,
  selectedInterviewId: S.NullOr(InterviewId),
  datetime: StringField,
  room: StringField,
  campus: StringField,
  mapLink: StringField,
  from: StringField,
  to: StringField,
  message: StringField,
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
  interviews: AsyncData.Idle(),
  selectedInterviewId: null,
  datetime: FieldValidation.NotValidated({ value: "" }),
  room: FieldValidation.NotValidated({ value: "" }),
  campus: FieldValidation.NotValidated({ value: "" }),
  mapLink: FieldValidation.NotValidated({ value: "" }),
  from: FieldValidation.NotValidated({ value: "" }),
  to: FieldValidation.NotValidated({ value: "" }),
  message: FieldValidation.NotValidated({ value: "" }),
  candidate: AsyncData.Idle(),
  feedback: null,
  isScheduling: false,
  isAccepting: false,
})
