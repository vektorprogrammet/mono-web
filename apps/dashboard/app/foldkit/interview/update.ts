import { Match as M } from "effect"
import { AsyncData, type Command, FieldValidation } from "foldkit"
import type { InterviewCommands } from "./command"
import type { Message } from "./message"
import { CandidateData, InterviewsData, type Model } from "./model"

const contextRules = FieldValidation.makeRules({
  required: "Velg et alternativ.",
  isEmpty: (value) => value.trim() === "",
})
const textRules = FieldValidation.makeRules({
  required: "Feltet må fylles ut.",
  isEmpty: (value) => value.trim() === "",
})
const timeRules = FieldValidation.makeRules({
  required: "Velg tidspunkt.",
  isEmpty: (value) => value.trim() === "",
  rules: [[
    (value) => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.parse("2026-08-01T00:00:00+02:00"),
    "Velg et gyldig tidspunkt etter 1. august 2026.",
  ]],
})

export const makeUpdate = ({
  LoadInterviews,
  ScheduleInterview,
  RefreshInterview,
  ReadCandidate,
  AcceptCandidate,
}: InterviewCommands) => (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  M.value(message).pipe(
    M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
    M.tagsExhaustive({
      SelectedDepartment: ({ value }) => [{
        ...model,
        departmentId: value,
        departmentValidation: FieldValidation.validate(contextRules)(value),
        interviews: InterviewsData.Idle(),
        selectedInterviewId: null,
        feedback: null,
      }, []],
      SelectedSemester: ({ value }) => [{
        ...model,
        semesterId: value,
        semesterValidation: FieldValidation.validate(contextRules)(value),
        interviews: InterviewsData.Idle(),
        selectedInterviewId: null,
        feedback: null,
      }, []],
      SubmittedContext: () => {
        if (AsyncData.isPending(model.interviews)) return [model, []]
        const departmentValidation = FieldValidation.validate(contextRules)(model.departmentId)
        const semesterValidation = FieldValidation.validate(contextRules)(model.semesterId)
        if (!FieldValidation.isValid(contextRules)(departmentValidation)
          || !FieldValidation.isValid(contextRules)(semesterValidation)) {
          return [{ ...model, departmentValidation, semesterValidation, feedback: "Velg avdeling og semester." }, []]
        }
        return [{
          ...model,
          departmentValidation,
          semesterValidation,
          interviews: InterviewsData.Loading(),
          selectedInterviewId: null,
          feedback: null,
        }, [LoadInterviews({ departmentId: model.departmentId, semesterId: model.semesterId })]]
      },
      SucceededLoadInterviews: ({ interviews }) => [{
        ...model,
        interviews: InterviewsData.Success({ data: interviews }),
        feedback: null,
      }, []],
      FailedLoadInterviews: ({ message }) => [{
        ...model,
        interviews: InterviewsData.Failure({ error: message }),
        selectedInterviewId: null,
        feedback: message,
      }, []],
      OpenedSchedule: ({ interviewId }) => [{
        ...model,
        selectedInterviewId: interviewId,
        interviewTime: FieldValidation.NotValidated({ value: "" }),
        room: FieldValidation.NotValidated({ value: "" }),
        campus: FieldValidation.NotValidated({ value: "" }),
        feedback: null,
      }, []],
      UpdatedInterviewTime: ({ value }) => [{
        ...model,
        interviewTime: FieldValidation.validate(timeRules)(value),
        feedback: null,
      }, []],
      UpdatedRoom: ({ value }) => [{
        ...model,
        room: FieldValidation.validate(textRules)(value),
        feedback: null,
      }, []],
      UpdatedCampus: ({ value }) => [{
        ...model,
        campus: FieldValidation.validate(textRules)(value),
        feedback: null,
      }, []],
      SubmittedSchedule: () => {
        if (model.isScheduling || model.selectedInterviewId === null) return [model, []]
        const interviewTime = FieldValidation.validate(timeRules)(model.interviewTime.value)
        const room = FieldValidation.validate(textRules)(model.room.value)
        const campus = FieldValidation.validate(textRules)(model.campus.value)
        if (!FieldValidation.isValid(timeRules)(interviewTime)
          || !FieldValidation.isValid(textRules)(room)
          || !FieldValidation.isValid(textRules)(campus)) {
          return [{ ...model, interviewTime, room, campus, feedback: "Kontroller feltene." }, []]
        }
        return [{ ...model, interviewTime, room, campus, isScheduling: true, feedback: null }, [
          ScheduleInterview({
            departmentId: model.departmentId,
            semesterId: model.semesterId,
            interviewId: model.selectedInterviewId,
            interviewTime: interviewTime.value,
            room: room.value,
            campus: campus.value,
          }),
        ]]
      },
      SucceededSchedule: () => {
        if (model.selectedInterviewId === null) return [{ ...model, isScheduling: false }, []]
        return [{ ...model, isScheduling: false }, [RefreshInterview({
          departmentId: model.departmentId,
          semesterId: model.semesterId,
          interviewId: model.selectedInterviewId,
        })]]
      },
      FailedSchedule: ({ message }) => [{ ...model, isScheduling: false, feedback: message }, []],
      SucceededRefreshInterview: ({ interview }) => {
        const current = AsyncData.getData(model.interviews)
        if (current._tag === "None") return [model, []]
        return [{
          ...model,
          interviews: InterviewsData.Success({
            data: current.value.map((candidate) => candidate.id === interview.id ? interview : candidate),
          }),
          feedback: interview.schedulingStatus === "pending" ? "Intervjuet er planlagt og invitert." : null,
        }, []]
      },
      OpenedCandidate: () => {
        if (AsyncData.isPending(model.candidate)) return [model, []]
        return [{ ...model, candidate: CandidateData.Loading(), feedback: null }, [
          ReadCandidate(),
        ]]
      },
      SucceededReadCandidate: ({ candidate }) => [{
        ...model,
        candidate: CandidateData.Success({ data: candidate }),
        feedback: candidate.schedulingStatus === "accepted" ? "Intervjutiden er akseptert." : null,
      }, []],
      FailedReadCandidate: ({ message }) => [{
        ...model,
        candidate: CandidateData.Failure({ error: message }),
        feedback: message,
      }, []],
      AcceptedCandidate: () => {
        if (model.isAccepting || AsyncData.isPending(model.candidate)) return [model, []]
        const candidate = AsyncData.getData(model.candidate)
        if (candidate._tag === "None" || candidate.value.schedulingStatus !== "pending") return [model, []]
        return [{ ...model, isAccepting: true, feedback: null }, [
          AcceptCandidate(),
        ]]
      },
      SucceededAcceptCandidate: () => [{
        ...model,
        isAccepting: false,
        candidate: CandidateData.Loading(),
      }, [
        ReadCandidate(),
      ]],
      FailedAcceptCandidate: ({ message }) => [{ ...model, isAccepting: false, feedback: message }, []],
    }),
  )
