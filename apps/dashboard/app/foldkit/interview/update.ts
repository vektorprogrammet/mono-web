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
  ConfirmCandidate,
  RejectCandidate,
  RequestNewTimeCandidate,
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
        return [{
          ...model,
          candidate: CandidateData.Loading(),
          responseMessage: FieldValidation.NotValidated({ value: "" }),
          isConfirming: false,
          isRejecting: false,
          isRequestingNewTime: false,
          feedback: null,
        }, [
          ReadCandidate(),
        ]]
      },
      SucceededReadCandidate: ({ candidate }) => [{
        ...model,
        candidate: CandidateData.Success({ data: candidate }),
        responseMessage: FieldValidation.NotValidated({ value: "" }),
        isConfirming: false,
        isRejecting: false,
        isRequestingNewTime: false,
        feedback: candidate.schedulingStatus === "accepted"
          ? "Intervjutiden er akseptert."
          : candidate.schedulingStatus === "cancelled"
            ? "Intervjuet er avvist."
            : candidate.schedulingStatus === "request_new_time"
              ? "Forespørselen om nytt tidspunkt er registrert."
              : null,
      }, []],
      FailedReadCandidate: ({ message }) => [{
        ...model,
        candidate: CandidateData.Failure({ error: message }),
        isConfirming: false,
        isRejecting: false,
        isRequestingNewTime: false,
        feedback: message,
      }, []],
      UpdatedResponseMessage: ({ value }) => [{
        ...model,
        responseMessage: FieldValidation.NotValidated({ value }),
        feedback: null,
      }, []],
      ConfirmedCandidate: () => {
        const candidate = AsyncData.getData(model.candidate)
        if (
          model.isConfirming ||
          model.isRejecting ||
          model.isRequestingNewTime ||
          AsyncData.isPending(model.candidate) ||
          candidate._tag === "None" ||
          candidate.value.schedulingStatus !== "pending"
        ) return [model, []]
        return [{ ...model, isConfirming: true, feedback: null }, [
          ConfirmCandidate(),
        ]]
      },
      RejectedCandidate: () => {
        const candidate = AsyncData.getData(model.candidate)
        if (
          model.isConfirming ||
          model.isRejecting ||
          model.isRequestingNewTime ||
          AsyncData.isPending(model.candidate) ||
          candidate._tag === "None" ||
          candidate.value.schedulingStatus !== "pending"
        ) return [model, []]
        return [{ ...model, isRejecting: true, feedback: null }, [
          RejectCandidate({ message: model.responseMessage.value }),
        ]]
      },
      RequestedNewTimeCandidate: () => {
        const candidate = AsyncData.getData(model.candidate)
        const responseMessage = FieldValidation.validate(textRules)(model.responseMessage.value)
        if (
          model.isConfirming ||
          model.isRejecting ||
          model.isRequestingNewTime ||
          AsyncData.isPending(model.candidate) ||
          candidate._tag === "None" ||
          candidate.value.schedulingStatus !== "pending"
        ) return [model, []]
        if (!FieldValidation.isValid(textRules)(responseMessage)) {
          return [{ ...model, responseMessage, feedback: "Skriv en melding før du ber om nytt tidspunkt." }, []]
        }
        return [{
          ...model,
          responseMessage,
          isRequestingNewTime: true,
          feedback: null,
        }, [
          RequestNewTimeCandidate({ message: responseMessage.value }),
        ]]
      },
      SucceededCandidateResponse: () => [{
        ...model,
        isConfirming: false,
        isRejecting: false,
        isRequestingNewTime: false,
        candidate: CandidateData.Loading(),
        feedback: null,
      }, [
        ReadCandidate(),
      ]],
      FailedCandidateResponse: ({ message }) => [{
        ...model,
        isConfirming: false,
        isRejecting: false,
        isRequestingNewTime: false,
        feedback: message,
      }, []],
    }),
  )
