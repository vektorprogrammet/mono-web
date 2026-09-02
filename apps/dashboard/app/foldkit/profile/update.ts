import { Match as M, Schema as S } from "effect";
import { FieldValidation } from "foldkit";
import type { Command } from "foldkit";
import type { ProfileCommands } from "./command";
import type { Message } from "./message";
import { ProfileCommand, type Model, type UserProfileObservation } from "./model";

const nameRules = FieldValidation.makeRules({
  required: "Feltet må fylles ut.",
  isEmpty: (value) => value.trim() === "",
  rules: [[(value) => value.trim().length <= 100, "Feltet kan ikke være lengre enn 100 tegn."]],
});

const emailRules = FieldValidation.makeRules({
  required: "E-post må fylles ut.",
  isEmpty: (value) => value.trim() === "",
  rules: [
    [
      (value) => {
        const separator = value.indexOf("@");
        return (
          value.length <= 320 &&
          separator > 0 &&
          separator === value.lastIndexOf("@") &&
          separator < value.length - 1 &&
          !/[\p{White_Space}\p{Cc}\p{Cf}]/u.test(value)
        );
      },
      "Ugyldig e-postadresse.",
    ],
  ],
});

const phoneRules = FieldValidation.makeRules({
  required: "Telefon må fylles ut.",
  isEmpty: (value) => value.trim() === "",
  rules: [
    [(value) => value.trim().length <= 32, "Telefonnummeret er for langt."],
    [(value) => /^[+\d][\d\s().-]*$/u.test(value.trim()), "Telefonnummeret er på feil format."],
  ],
});

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
  ({ SaveProfile }: ProfileCommands) =>
  (model: Model, message: Message): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
    M.value(message).pipe(
      M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
      M.tagsExhaustive({
        UpdatedProfileField: ({ field, value }) => {
          if (model.isSaving) return [model, []];
          const rules = field === "email" ? emailRules : field === "phone" ? phoneRules : nameRules;
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

          const command = S.decodeUnknownSync(ProfileCommand)(
            {
              commandId: `${validated.commandIdSeed}-${validated.commandSequence}`,
              etag: validated.etag,
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
        SucceededProfileSave: ({ requestId, profile, etag }) =>
          requestId !== model.requestId
            ? [model, []]
            : [
                {
                  ...makeInitialFrom(model, profile, etag),
                  isSaving: false,
                  commandSequence: model.commandSequence + 1,
                  status: "Profilen er lagret.",
                },
                [],
              ],
        FailedProfileSave: ({ requestId, failure }) =>
          requestId !== model.requestId
            ? [model, []]
            : [{ ...model, isSaving: false, failure, status: null }, []],
      }),
    );

const makeInitialFrom = (
  model: Model,
  profile: UserProfileObservation,
  etag: Model["etag"],
): Model => ({
  ...model,
  profile,
  etag,
  firstName: FieldValidation.NotValidated({ value: profile.firstName }),
  lastName: FieldValidation.NotValidated({ value: profile.lastName }),
  email: FieldValidation.NotValidated({ value: profile.email }),
  phone: FieldValidation.NotValidated({ value: profile.phone }),
});
