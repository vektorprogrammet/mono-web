import { CandidateInterviewView } from "@vektorprogrammet/sdk/effect"
import { Schema as S } from "effect"
import { AsyncData, FieldValidation } from "foldkit"

export const CandidateData = AsyncData.Schema(CandidateInterviewView, S.String)

const StringField = FieldValidation.Field(S.String)

export const Model = S.Struct({
  responseMessage: StringField,
  candidate: CandidateData.schema,
  feedback: S.NullOr(S.String),
  isConfirming: S.Boolean,
  isRejecting: S.Boolean,
  isRequestingNewTime: S.Boolean,
})
export type Model = S.Schema.Type<typeof Model>

export const makeInitialModel = (): Model => ({
  responseMessage: FieldValidation.NotValidated({ value: "" }),
  candidate: AsyncData.Idle(),
  feedback: null,
  isConfirming: false,
  isRejecting: false,
  isRequestingNewTime: false,
})
