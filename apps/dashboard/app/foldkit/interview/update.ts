import { Match as M } from "effect"
import { AsyncData, type Command, FieldValidation } from "foldkit"
import type { InterviewCommands } from "./command"
import type { Message } from "./message"
import { CandidateData, InterviewsData, type Model } from "./model"

const textRules = FieldValidation.makeRules({
  required: "Feltet må fylles ut.",
  isEmpty: (value) => value.trim() === "",
})
const datetimeRules = FieldValidation.makeRules({
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
        datetime: FieldValidation.NotValidated({ value: "" }),
        room: FieldValidation.NotValidated({ value: "" }),
        campus: FieldValidation.NotValidated({ value: "" }),
        mapLink: FieldValidation.NotValidated({ value: "" }),
        from: FieldValidation.NotValidated({ value: "" }),
        to: FieldValidation.NotValidated({ value: "" }),
        message: FieldValidation.NotValidated({ value: "" }),
        feedback: null,
      }, []],
      UpdatedDatetime: ({ value }) => [{
        ...model,
        datetime: FieldValidation.validate(datetimeRules)(value),
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
      UpdatedMapLink: ({ value }) => [{
        ...model,
        mapLink: FieldValidation.validate(textRules)(value),
        feedback: null,
      }, []],
      UpdatedFrom: ({ value }) => [{
        ...model,
        from: FieldValidation.validate(textRules)(value),
        feedback: null,
      }, []],
      UpdatedTo: ({ value }) => [{
        ...model,
        to: FieldValidation.validate(textRules)(value),
        feedback: null,
      }, []],
      UpdatedMessage: ({ value }) => [{
        ...model,
        message: FieldValidation.validate(textRules)(value),
        feedback: null,
      }, []],
      SubmittedSchedule: () => {
        if (model.isScheduling || model.selectedInterviewId === null) return [model, []]
        const datetime = FieldValidation.validate(datetimeRules)(model.datetime.value)
        const room = FieldValidation.validate(textRules)(model.room.value)
        const campus = FieldValidation.validate(textRules)(model.campus.value)
        const mapLink = FieldValidation.validate(textRules)(model.mapLink.value)
        const from = FieldValidation.validate(textRules)(model.from.value)
        const to = FieldValidation.validate(textRules)(model.to.value)
        const message = FieldValidation.validate(textRules)(model.message.value)
        const valid = [
          FieldValidation.isValid(datetimeRules)(datetime),
          FieldValidation.isValid(textRules)(room),
          FieldValidation.isValid(textRules)(campus),
          FieldValidation.isValid(textRules)(mapLink),
          FieldValidation.isValid(textRules)(from),
          FieldValidation.isValid(textRules)(to),
          FieldValidation.isValid(textRules)(message),
        ].every(Boolean)
        if (!valid) {
          return [{
            ...model,
            datetime,
            room,
            campus,
            mapLink,
            from,
            to,
            message,
            feedback: "Kontroller feltene.",
          }, []]
        }
        return [{
          ...model,
          datetime,
          room,
          campus,
          mapLink,
          from,
          to,
          message,
          isScheduling: true,
          feedback: null,
        }, [
          ScheduleInterview({
            interviewId: model.selectedInterviewId,
            datetime: datetime.value,
            room: room.value,
            campus: campus.value,
            mapLink: mapLink.value,
            from: from.value,
            to: to.value,
            message: message.value,
          }),
        ]]
      },
      SucceededSchedule: () => {
        if (model.selectedInterviewId === null) return [{ ...model, isScheduling: false }, []]
        return [{
          ...model,
          isScheduling: false,
        }, [RefreshInterview({ interviewId: model.selectedInterviewId })]]
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
