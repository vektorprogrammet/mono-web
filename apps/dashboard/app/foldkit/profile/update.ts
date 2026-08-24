import { UpdateOwnProfileCommand } from "@vektorprogrammet/sdk/effect";
import { ProfileObservationData, type Model, type UserProfileObservation } from "./model";
import type { ProfileCommands } from "./command";
import { Match as M, Schema as S } from "effect";
import { AsyncData, FieldValidation } from "foldkit";
import type { Command } from "foldkit";
import {
  CancelledProfileEdit,
  FailedProfileSave,
  FailedReadProfile,
  OpenedProfileEditor,
  SucceededProfileSave,
  SucceededReadProfile,
  UpdatedProfileField,
  SubmittedProfile,
  type Message,
} from "./message";

const nameRules = FieldValidation.makeRules({
  required: "Feltet må fylles ut.",
  isEmpty: (value) => value.trim() === "",
  rules: [
    [(value) => value.trim().length >= 2, "Feltet må inneholde minst to tegn."],
    [(value) => value.trim().length <= 100, "Feltet kan ikke være lengre enn 100 tegn."],
    [(value) => /^[A-Za-zÀ-ÿ' -]+$/.test(value.trim()), "Feltet inneholder ugyldige tegn."],
  ],
});

const emailRules = FieldValidation.makeRules({
  required: "E-post må fylles ut.",
  isEmpty: (value) => value.trim() === "",
  rules: [
    [(value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()), "Ugyldig e-postadresse."],
    [(value) => value.trim().length <= 254, "E-posten kan ikke være lengre enn 254 tegn."],
  ],
});

const phoneRules = FieldValidation.makeRules({
  required: "",
  isEmpty: (value) => value.trim() === "",
  rules: [
    [
      (value) => /^(\d{3}\s\d{2}\s\d{3}|\d{8})$/.test(value.trim()),
      "Telefonnummeret er på feil format.",
    ],
  ],
});

const fieldIsInvalid = (state: Model["firstName"]): boolean =>
  state._tag === "Invalid";

const allFieldsValid = (model: Model): boolean =>
  FieldValidation.isValid(nameRules)(model.firstName) &&
  FieldValidation.isValid(nameRules)(model.lastName) &&
  FieldValidation.isValid(emailRules)(model.email) &&
  FieldValidation.isValid(phoneRules)(model.phone);

const validatedFields = (model: Model): Model => ({
  ...model,
  firstName: FieldValidation.validateAll(nameRules)(model.firstName.value),
  lastName: FieldValidation.validateAll(nameRules)(model.lastName.value),
  email: FieldValidation.validateAll(emailRules)(model.email.value),
  phone: FieldValidation.validateAll(phoneRules)(model.phone.value),
});

export const makeUpdate =
  ({ ReadProfile, SaveProfile }: ProfileCommands) =>
  (model: Model, message: Message): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
    M.value(message).pipe(
      M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
      M.tagsExhaustive({
        OpenedProfileEditor: () => {
          if (model.profile._tag !== "Idle") return [model, []];
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              profile: ProfileObservationData.Loading(),
              requestId,
              failure: null,
              status: null,
            },
            [ReadProfile({ requestId })],
          ];
        },
        SucceededReadProfile: ({ requestId, profile }) =>
          requestId !== model.requestId
            ? [model, []]
            : [
                {
                  ...makeInitialFrom(model, profile),
                  status: null,
                },
                [],
              ],
        FailedReadProfile: ({ requestId, failure }) =>
          requestId !== model.requestId
            ? [model, []]
            : [{ ...model, profile: ProfileObservationData.Failure({ error: failure }) }, []],
        UpdatedProfileField: ({ field, value }) => {
          if (model.isSaving) return [model, []];
          const rules =
            field === "email" ? emailRules : field === "phone" ? phoneRules : nameRules;
          return [
            {
              ...model,
              [field]: FieldValidation.validate(rules)(value),
              failure: null,
            } as Model,
            [],
          ];
        },
        SubmittedProfile: () => {
          if (model.isSaving) return [model, []];
          const validated = validatedFields(model);
          if (!allFieldsValid(validated)) return [validated, []];
          const observation = AsyncData.getData(validated.profile);
          if (observation._tag === "None") return [validated, []];

          const command = S.decodeUnknownSync(UpdateOwnProfileCommand)(
            {
              _tag: "UpdateOwnProfile",
              commandId: `${validated.commandIdSeed}-${validated.commandSequence}`,
              expectedNameRevision: observation.value.nameRevision,
              expectedContactRevision: observation.value.contactRevision,
              firstName: validated.firstName.value.trim(),
              lastName: validated.lastName.value.trim(),
              email: validated.email.value.trim(),
              phone: validated.phone.value.trim(),
            },
            { onExcessProperty: "error" },
          );
          const requestId = validated.requestId + 1;
          return [
            { ...validated, isSaving: true, requestId, failure: null, status: null },
            [SaveProfile({ requestId, command })],
          ];
        },
        CancelledProfileEdit: () => [model, []],
        SucceededProfileSave: ({ requestId, profile }) =>
          requestId !== model.requestId
            ? [model, []]
            : [
                {
                  ...makeInitialFrom(model, profile),
                  isSaving: false,
                  commandSequence: model.commandSequence + 1,
                  status:
                    "Profilen er lagret. De viste verdiene kommer fra en fersk lesning.",
                },
                [],
              ],
        FailedProfileSave: ({ requestId, failure }) =>
          requestId !== model.requestId
            ? [model, []]
            : [{ ...model, isSaving: false, failure, status: null }, []],
      }),
    );

const makeInitialFrom = (model: Model, profile: UserProfileObservation): Model => ({
  ...model,
  profile: ProfileObservationData.Success({ data: profile }),
  firstName: FieldValidation.NotValidated({ value: profile.firstName }),
  lastName: FieldValidation.NotValidated({ value: profile.lastName }),
  email: FieldValidation.NotValidated({ value: profile.email }),
  phone: FieldValidation.NotValidated({ value: profile.phone ?? "" }),
});

void fieldIsInvalid;
