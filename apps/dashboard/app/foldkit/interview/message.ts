import { Schema as S } from "effect"
import { m } from "foldkit/message"
import { AssignedInterview, CandidateInterviewView } from "@vektorprogrammet/sdk/effect"

export const SelectedDepartment = m("SelectedDepartment", { value: S.String })
export const SelectedSemester = m("SelectedSemester", { value: S.String })
export const SubmittedContext = m("SubmittedContext")
export const SucceededLoadInterviews = m("SucceededLoadInterviews", { interviews: S.Array(AssignedInterview) })
export const FailedLoadInterviews = m("FailedLoadInterviews", { message: S.String })
export const OpenedSchedule = m("OpenedSchedule", { interviewId: S.String })
export const UpdatedInterviewTime = m("UpdatedInterviewTime", { value: S.String })
export const UpdatedRoom = m("UpdatedRoom", { value: S.String })
export const UpdatedCampus = m("UpdatedCampus", { value: S.String })
export const SubmittedSchedule = m("SubmittedSchedule")
export const SucceededSchedule = m("SucceededSchedule")
export const FailedSchedule = m("FailedSchedule", { message: S.String })
export const SucceededRefreshInterview = m("SucceededRefreshInterview", { interview: AssignedInterview })
export const OpenedCandidate = m("OpenedCandidate")
export const SucceededReadCandidate = m("SucceededReadCandidate", { candidate: CandidateInterviewView })
export const FailedReadCandidate = m("FailedReadCandidate", { message: S.String })
export const AcceptedCandidate = m("AcceptedCandidate")
export const SucceededAcceptCandidate = m("SucceededAcceptCandidate")
export const FailedAcceptCandidate = m("FailedAcceptCandidate", { message: S.String })

export const Message = S.Union([
  SelectedDepartment,
  SelectedSemester,
  SubmittedContext,
  SucceededLoadInterviews,
  FailedLoadInterviews,
  OpenedSchedule,
  UpdatedInterviewTime,
  UpdatedRoom,
  UpdatedCampus,
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
