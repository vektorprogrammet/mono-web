import { Match as M } from "effect"
import { AsyncData, type Command, FieldValidation } from "foldkit"
import type { InterviewCommands } from "./command"
import type { Message } from "./message"
import { CandidateData, type Model } from "./model"

const textRules = FieldValidation.makeRules({
  required: "Feltet må fylles ut.",
  isEmpty: (value) => value.trim() === "",
})

export const makeUpdate = ({
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
          return [{
            ...model,
            responseMessage,
            feedback: "Skriv en melding før du ber om nytt tidspunkt.",
          }, []]
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
