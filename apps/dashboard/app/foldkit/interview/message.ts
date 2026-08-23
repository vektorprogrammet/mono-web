import { CandidateInterviewView } from "@vektorprogrammet/sdk/effect"
import { Schema as S } from "effect"
import { m } from "foldkit/message"

export const OpenedCandidate = m("OpenedCandidate")
export const SucceededReadCandidate = m("SucceededReadCandidate", {
  candidate: CandidateInterviewView,
})
export const FailedReadCandidate = m("FailedReadCandidate", { message: S.String })
export const UpdatedResponseMessage = m("UpdatedResponseMessage", { value: S.String })
export const ConfirmedCandidate = m("ConfirmedCandidate")
export const RejectedCandidate = m("RejectedCandidate")
export const RequestedNewTimeCandidate = m("RequestedNewTimeCandidate")
export const SucceededCandidateResponse = m("SucceededCandidateResponse")
export const FailedCandidateResponse = m("FailedCandidateResponse", { message: S.String })

export const Message = S.Union([
  OpenedCandidate,
  SucceededReadCandidate,
  FailedReadCandidate,
  UpdatedResponseMessage,
  ConfirmedCandidate,
  RejectedCandidate,
  RequestedNewTimeCandidate,
  SucceededCandidateResponse,
  FailedCandidateResponse,
])
export type Message = S.Schema.Type<typeof Message>
