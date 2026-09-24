import { Predicate } from "effect";
import { containsRecruitmentInvitationCapabilitySequence,
RecruitmentInvitationResponseMessageSchema, } from "@vektorprogrammet/http-api"
import { Match as M, Schema as S } from "effect";
import { AsyncData, FieldValidation, Update } from "foldkit";
import type { InterviewCommands } from "./command";
import { type InvitationResponseAction, type InvitationResponseObservation, InvitationBridgeFailureSchema } from "./bridge";
import type { Message } from "./message";
import { InvitationResponseData, type Model } from "./model";

const isInvitationResponseMessage = S.is(RecruitmentInvitationResponseMessageSchema);

const ForbiddenCapabilitySequenceMessage = "Meldingen inneholder innhold som ikke er tillatt.";

const containsForbiddenCapabilitySequence = (value: string): boolean =>
  containsRecruitmentInvitationCapabilitySequence(value);

const editableResponseMessage = (value: string): Model["responseMessage"] =>
  containsForbiddenCapabilitySequence(value)
    ? FieldValidation.Invalid({
        value: "",
        errors: [ForbiddenCapabilitySequenceMessage],
      })
    : FieldValidation.NotValidated({ value });

const sanitizeInvalidResponseMessage = (
  field: Model["responseMessage"],
): Model["responseMessage"] =>
  Predicate.isTagged(field, "Invalid") && containsForbiddenCapabilitySequence(field.value)
    ? FieldValidation.Invalid({
        value: "",
        errors: [ForbiddenCapabilitySequenceMessage],
      })
    : field;

const isSanitizedCapabilityRejection = (field: Model["responseMessage"]): boolean =>
  Predicate.isTagged(field, "Invalid") &&
  field.value === "" &&
  field.errors.includes(ForbiddenCapabilitySequenceMessage);

const requiredResponseMessageRules = FieldValidation.makeRules({
  required: "Feltet må fylles ut.",
  isEmpty: (value) => value.trim() === "",
  rules: [
    [(value) => value.trim().length <= 2_000, "Meldingen kan ikke være lengre enn 2000 tegn."],
    [(value) => isInvitationResponseMessage(value.trim()), ForbiddenCapabilitySequenceMessage],
  ],
});

const optionalResponseMessageRules = FieldValidation.makeRules({
  required: "",
  isEmpty: () => false,
  rules: [
    [(value) => value.trim().length <= 2_000, "Meldingen kan ikke være lengre enn 2000 tegn."],
    [
      (value) => value.trim() === "" || isInvitationResponseMessage(value.trim()),
      ForbiddenCapabilitySequenceMessage,
    ],
  ],
});

const actionMatchesObservation = (
  action: InvitationResponseAction,
  responseState: InvitationResponseObservation["responseState"],
): boolean => {
  switch (action) {
    case "Confirm":
      return responseState === "Accepted";
    case "Reject":
      return responseState === "Rejected";
    case "RequestNewTime":
      return responseState === "RequestedNewTime";
  }
};

export const updateFor =
  ({
    ReadInvitationResponse,
    ConfirmInvitation,
    RejectInvitation,
    RequestNewInvitationTime,
  }: InterviewCommands) =>
  (model: Model, message: Message): Update.Return<Model, Message> =>
    M.value(message).pipe(
      M.withReturnType<Update.Return<Model, Message>>(),
      M.tagsExhaustive({
        OpenedInvitationResponse: () => {
          if (!Predicate.isTagged(model.invitationResponse, "Idle")) return ({ model: model, commands: [] });
          const requestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              invitationResponse: InvitationResponseData.Loading(),
              requestId,
              failure: null,
              validationFeedback: null,
            }, commands: [ReadInvitationResponse({ requestId })] });
        },
        SucceededReadInvitationResponse: ({ requestId, observation, etag }) =>
          requestId !== model.requestId || model.selectedAction !== null
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  invitationResponse: InvitationResponseData.Success({ data: observation }),
                  etag,
                  failure: null,
                  validationFeedback: null,
                }, commands: [] }),
        FailedReadInvitationResponse: ({ requestId, failure }) =>
          requestId !== model.requestId || model.selectedAction !== null
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  invitationResponse: InvitationResponseData.Failure({ error: failure }),
                  failure: null,
                  validationFeedback: null,
                }, commands: [] }),
        UpdatedResponseMessage: ({ value }) =>
          model.selectedAction !== null
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  responseMessage: editableResponseMessage(value),
                  failure: null,
                  validationFeedback: null,
                }, commands: [] }),
        ConfirmedInvitation: () => {
          const observation = AsyncData.getData(model.invitationResponse);

          if (
            model.selectedAction !== null ||
            Predicate.isTagged(observation, "None") ||
            model.etag === null ||
            observation.value.responseState !== "Pending"
          )
            return ({ model: model, commands: [] });
          const requestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              selectedAction: "Confirm",
              requestId,
              failure: null,
              validationFeedback: null,
            }, commands: [ConfirmInvitation({ requestId, etag: model.etag })] });
        },
        RejectedInvitation: () => {
          const observation = AsyncData.getData(model.invitationResponse);

          if (
            model.selectedAction !== null ||
            Predicate.isTagged(observation, "None") ||
            model.etag === null ||
            observation.value.responseState !== "Pending"
          )
            return ({ model: model, commands: [] });

          if (isSanitizedCapabilityRejection(model.responseMessage)) return ({ model: model, commands: [] });

          const responseMessage = sanitizeInvalidResponseMessage(
            FieldValidation.validate(optionalResponseMessageRules)(model.responseMessage.value),
          );

          if (!FieldValidation.isValid(optionalResponseMessageRules)(responseMessage)) {
            return ({ model: 
              {
                ...model,
                responseMessage,
                failure: null,
                validationFeedback: "Meldingen kan ikke være lengre enn 2000 tegn.",
              }, commands: [] });
          }

          const requestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              responseMessage,
              selectedAction: "Reject",
              requestId,
              failure: null,
              validationFeedback: null,
            }, commands: [
              RejectInvitation({
                requestId,
                etag: model.etag,
                message: responseMessage.value.trim() === "" ? null : responseMessage.value.trim(),
              }),
            ] });
        },
        RequestedNewInvitationTime: () => {
          const observation = AsyncData.getData(model.invitationResponse);

          if (
            model.selectedAction !== null ||
            Predicate.isTagged(observation, "None") ||
            model.etag === null ||
            observation.value.responseState !== "Pending"
          )
            return ({ model: model, commands: [] });

          if (isSanitizedCapabilityRejection(model.responseMessage)) return ({ model: model, commands: [] });

          const responseMessage = sanitizeInvalidResponseMessage(
            FieldValidation.validate(requiredResponseMessageRules)(model.responseMessage.value),
          );

          if (!FieldValidation.isValid(requiredResponseMessageRules)(responseMessage)) {
            return ({ model: 
              {
                ...model,
                responseMessage,
                failure: null,
                validationFeedback:
                  model.responseMessage.value.trim().length === 0
                    ? "Skriv en melding før du ber om nytt tidspunkt."
                    : null,
              }, commands: [] });
          }

          const requestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              responseMessage,
              selectedAction: "RequestNewTime",
              requestId,
              failure: null,
              validationFeedback: null,
            }, commands: [
              RequestNewInvitationTime({
                requestId,
                etag: model.etag,
                message: responseMessage.value.trim(),
              }),
            ] });
        },
        SucceededInvitationResponse: ({ requestId, action, observation, etag }) => {
          if (requestId !== model.requestId || action !== model.selectedAction) {
            return ({ model: model, commands: [] });
          }

          if (!actionMatchesObservation(action, observation.responseState)) {
            return ({ model: 
              {
                ...model,
                selectedAction: null,
                failure: InvitationBridgeFailureSchema.cases.InvitationUnavailable.make({
                  message: "Fresh invitation response did not match the command",
                }),
              }, commands: [] });
          }

          return ({ model: 
            {
              ...model,
              invitationResponse: InvitationResponseData.Success({ data: observation }),
              etag,
              responseMessage: FieldValidation.NotValidated({ value: "" }),
              selectedAction: null,
              failure: null,
              validationFeedback: null,
            }, commands: [] });
        },
        FailedInvitationResponse: ({ requestId, action, failure }) =>
          requestId !== model.requestId || action !== model.selectedAction
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  selectedAction: null,
                  failure,
                  validationFeedback: null,
                }, commands: [] }),
      }),
    );
