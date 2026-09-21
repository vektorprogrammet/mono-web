import { containsRecruitmentInvitationCapabilitySequence,
RecruitmentInvitationResponseMessageSchema, } from "@vektorprogrammet/http-api"
import { Match as M, Schema as S } from "effect";
import { AsyncData, type Command, FieldValidation } from "foldkit";
import type { InterviewCommands } from "./command";
import type { InvitationResponseAction, InvitationResponseObservation } from "./bridge";
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
  field._tag === "Invalid" && containsForbiddenCapabilitySequence(field.value)
    ? FieldValidation.Invalid({
        value: "",
        errors: [ForbiddenCapabilitySequenceMessage],
      })
    : field;

const isSanitizedCapabilityRejection = (field: Model["responseMessage"]): boolean =>
  field._tag === "Invalid" &&
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

export const makeUpdate =
  ({
    ReadInvitationResponse,
    ConfirmInvitation,
    RejectInvitation,
    RequestNewInvitationTime,
  }: InterviewCommands) =>
  (model: Model, message: Message): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
    M.value(message).pipe(
      M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
      M.tagsExhaustive({
        OpenedInvitationResponse: () => {
          if (model.invitationResponse._tag !== "Idle") return [model, []];
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              invitationResponse: InvitationResponseData.Loading(),
              requestId,
              failure: null,
              validationFeedback: null,
            },
            [ReadInvitationResponse({ requestId })],
          ];
        },
        SucceededReadInvitationResponse: ({ requestId, observation, etag }) =>
          requestId !== model.requestId || model.selectedAction !== null
            ? [model, []]
            : [
                {
                  ...model,
                  invitationResponse: InvitationResponseData.Success({ data: observation }),
                  etag,
                  failure: null,
                  validationFeedback: null,
                },
                [],
              ],
        FailedReadInvitationResponse: ({ requestId, failure }) =>
          requestId !== model.requestId || model.selectedAction !== null
            ? [model, []]
            : [
                {
                  ...model,
                  invitationResponse: InvitationResponseData.Failure({ error: failure }),
                  failure: null,
                  validationFeedback: null,
                },
                [],
              ],
        UpdatedResponseMessage: ({ value }) =>
          model.selectedAction !== null
            ? [model, []]
            : [
                {
                  ...model,
                  responseMessage: editableResponseMessage(value),
                  failure: null,
                  validationFeedback: null,
                },
                [],
              ],
        ConfirmedInvitation: () => {
          const observation = AsyncData.getData(model.invitationResponse);
          if (
            model.selectedAction !== null ||
            observation._tag === "None" ||
            model.etag === null ||
            observation.value.responseState !== "Pending"
          )
            return [model, []];
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              selectedAction: "Confirm",
              requestId,
              failure: null,
              validationFeedback: null,
            },
            [ConfirmInvitation({ requestId, etag: model.etag })],
          ];
        },
        RejectedInvitation: () => {
          const observation = AsyncData.getData(model.invitationResponse);
          if (
            model.selectedAction !== null ||
            observation._tag === "None" ||
            model.etag === null ||
            observation.value.responseState !== "Pending"
          )
            return [model, []];
          if (isSanitizedCapabilityRejection(model.responseMessage)) return [model, []];
          const responseMessage = sanitizeInvalidResponseMessage(
            FieldValidation.validate(optionalResponseMessageRules)(model.responseMessage.value),
          );
          if (!FieldValidation.isValid(optionalResponseMessageRules)(responseMessage)) {
            return [
              {
                ...model,
                responseMessage,
                failure: null,
                validationFeedback: "Meldingen kan ikke være lengre enn 2000 tegn.",
              },
              [],
            ];
          }
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              responseMessage,
              selectedAction: "Reject",
              requestId,
              failure: null,
              validationFeedback: null,
            },
            [
              RejectInvitation({
                requestId,
                etag: model.etag,
                message: responseMessage.value.trim() === "" ? null : responseMessage.value.trim(),
              }),
            ],
          ];
        },
        RequestedNewInvitationTime: () => {
          const observation = AsyncData.getData(model.invitationResponse);
          if (
            model.selectedAction !== null ||
            observation._tag === "None" ||
            model.etag === null ||
            observation.value.responseState !== "Pending"
          )
            return [model, []];
          if (isSanitizedCapabilityRejection(model.responseMessage)) return [model, []];
          const responseMessage = sanitizeInvalidResponseMessage(
            FieldValidation.validate(requiredResponseMessageRules)(model.responseMessage.value),
          );
          if (!FieldValidation.isValid(requiredResponseMessageRules)(responseMessage)) {
            return [
              {
                ...model,
                responseMessage,
                failure: null,
                validationFeedback:
                  model.responseMessage.value.trim().length === 0
                    ? "Skriv en melding før du ber om nytt tidspunkt."
                    : null,
              },
              [],
            ];
          }
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              responseMessage,
              selectedAction: "RequestNewTime",
              requestId,
              failure: null,
              validationFeedback: null,
            },
            [
              RequestNewInvitationTime({
                requestId,
                etag: model.etag,
                message: responseMessage.value.trim(),
              }),
            ],
          ];
        },
        SucceededInvitationResponse: ({ requestId, action, observation, etag }) => {
          if (requestId !== model.requestId || action !== model.selectedAction) {
            return [model, []];
          }
          if (!actionMatchesObservation(action, observation.responseState)) {
            return [
              {
                ...model,
                selectedAction: null,
                failure: {
                  _tag: "InvitationUnavailable",
                  message: "Fresh invitation response did not match the command",
                },
              },
              [],
            ];
          }
          return [
            {
              ...model,
              invitationResponse: InvitationResponseData.Success({ data: observation }),
              etag,
              responseMessage: FieldValidation.NotValidated({ value: "" }),
              selectedAction: null,
              failure: null,
              validationFeedback: null,
            },
            [],
          ];
        },
        FailedInvitationResponse: ({ requestId, action, failure }) =>
          requestId !== model.requestId || action !== model.selectedAction
            ? [model, []]
            : [
                {
                  ...model,
                  selectedAction: null,
                  failure,
                  validationFeedback: null,
                },
                [],
              ],
      }),
    );
