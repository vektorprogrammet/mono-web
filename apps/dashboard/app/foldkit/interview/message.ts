import { Schema as S } from "effect"
import { m } from "foldkit/message"
import { CandidateInterviewView, Interview, InterviewId } from "@vektorprogrammet/sdk/effect"

export const SucceededLoadInterviews = m("SucceededLoadInterviews", { interviews: S.Array(Interview) })
export const FailedLoadInterviews = m("FailedLoadInterviews", { message: S.String })
export const OpenedSchedule = m("OpenedSchedule", { interviewId: InterviewId })
export const UpdatedDatetime = m("UpdatedDatetime", { value: S.String })
export const UpdatedRoom = m("UpdatedRoom", { value: S.String })
export const UpdatedCampus = m("UpdatedCampus", { value: S.String })
export const UpdatedMapLink = m("UpdatedMapLink", { value: S.String })
export const UpdatedFrom = m("UpdatedFrom", { value: S.String })
export const UpdatedTo = m("UpdatedTo", { value: S.String })
export const UpdatedMessage = m("UpdatedMessage", { value: S.String })
export const SubmittedSchedule = m("SubmittedSchedule")
export const SucceededSchedule = m("SucceededSchedule")
export const FailedSchedule = m("FailedSchedule", { message: S.String })
export const SucceededRefreshInterview = m("SucceededRefreshInterview", { interview: Interview })
export const OpenedCandidate = m("OpenedCandidate")
export const SucceededReadCandidate = m("SucceededReadCandidate", { candidate: CandidateInterviewView })
export const FailedReadCandidate = m("FailedReadCandidate", { message: S.String })
export const AcceptedCandidate = m("AcceptedCandidate")
export const SucceededAcceptCandidate = m("SucceededAcceptCandidate")
export const FailedAcceptCandidate = m("FailedAcceptCandidate", { message: S.String })

export const Message = S.Union([
  SucceededLoadInterviews,
  FailedLoadInterviews,
  OpenedSchedule,
  UpdatedDatetime,
  UpdatedRoom,
  UpdatedCampus,
  UpdatedMapLink,
  UpdatedFrom,
  UpdatedTo,
  UpdatedMessage,
  SubmittedSchedule,
  SucceededSchedule,
  FailedSchedule,
  SucceededRefreshInterview,
  OpenedCandidate,
  SucceededReadCandidate,
  FailedReadCandidate,
  AcceptedCandidate,
  SucceededAcceptCandidate,
  FailedAcceptCandidate,
])
export type Message = S.Schema.Type<typeof Message>
