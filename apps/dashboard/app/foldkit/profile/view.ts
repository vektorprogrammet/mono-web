import { Button, Input } from "@foldkit/ui";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  CancelledProfileEdit,
  FailedProfileSave,
  OpenedProfileEditor,
  SubmittedProfile,
  UpdatedProfileField,
  type Message,
} from "./message";
import type { Model } from "./model";

const textField = (
  config: {
    id: string;
    label: string;
    value: string;
    field: Model["firstName"];
    isDisabled: boolean;
    hint?: string;
    type?: string;
    autocomplete?: string;
  },
  h: HtmlBuilder<Message>,
): Html =>
  Input.view(
    {
      id: config.id,
      value: config.value,
      onInput: (value) => UpdatedProfileField({ field: fieldKey(config.id), value }),
      isDisabled: config.isDisabled,
      isInvalid: config.field._tag === "Invalid",
      type: config.type ?? "text",
      toView: ({ input, label, description }) =>
        h.div(
          [h.Class("fk-field")],
          [
            h.label([...label, h.Class("fk-label")], [config.label]),
            h.input([...input, h.Class("fk-input")]),
            config.hint === undefined
              ? h.empty
              : h.p([...description, h.Class("fk-field-hint")], [config.hint]),
            config.field._tag === "Invalid"
              ? h.p(
                  [h.Id(`${config.id}-error`), h.Class("fk-field-error"), h.Role("alert")],
                  [config.field.errors.join(" ")],
                )
              : h.empty,
          ],
        ),
    },
    h,
  );

const fieldKey = (id: string): "firstName" | "lastName" | "email" | "phone" => {
  if (id === "profile-first-name") return "firstName";
  if (id === "profile-last-name") return "lastName";
  if (id === "profile-email") return "email";
  return "phone";
};

const actionButton = (
  label: string,
  onClick: Message,
  variant: "primary" | "secondary",
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  Button.view(
    {
      onClick,
      isDisabled,
      type: "button",
      toView: ({ button }) =>
        h.button([...button, h.Class(`fk-button fk-button--${variant}`)], [label]),
    },
    h,
  );

const profileForm = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isSaving = model.isSaving;
  return h.form(
    [h.Class("fk-profile__form"), h.Attribute("novalidate", "")],
    [
      h.div(
        [h.Class("fk-form-grid")],
        [
          textField(
            {
              id: "profile-first-name",
              label: "Fornavn",
              value: model.firstName.value,
              field: model.firstName,
              isDisabled: isSaving,
              autocomplete: "given-name",
            },
            h,
          ),
          textField(
            {
              id: "profile-last-name",
              label: "Etternavn",
              value: model.lastName.value,
              field: model.lastName,
              isDisabled: isSaving,
              autocomplete: "family-name",
            },
            h,
          ),
          textField(
            {
              id: "profile-email",
              label: "E-post",
              value: model.email.value,
              field: model.email,
              isDisabled: isSaving,
              type: "email",
              autocomplete: "email",
            },
            h,
          ),
          textField(
            {
              id: "profile-phone",
              label: "Telefon",
              value: model.phone.value,
              field: model.phone,
              isDisabled: isSaving,
              type: "tel",
              autocomplete: "tel",
              hint: "Valgfritt. Format: 000 00 000 eller 8 siffer.",
            },
            h,
          ),
        ],
      ),
      model.failure === null
        ? h.empty
        : h.section(
            [h.Class("fk-feedback fk-feedback--error"), h.Role("alert")],
            [
              h.h2([], ["Lagringen feilet"]),
              h.p([], [model.failure.message]),
            ],
          ),
      model.status === null
        ? h.empty
        : h.p([h.Class("fk-feedback"), h.Role("status")], [model.status]),
      h.div(
        [h.Class("fk-actions")],
        [
          actionButton(
            isSaving ? "Lagrer …" : "Lagre endringer",
            SubmittedProfile(),
            "primary",
            isSaving,
            h,
          ),
          actionButton(
            "Avbryt",
            CancelledProfileEdit(),
            "secondary",
            false,
            h,
          ),
        ],
      ),
    ],
  );
};

const loadingState = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("fk-loading"), h.Role("status"), h.AriaLive("polite")],
    [
      h.span([h.Class("fk-spinner"), h.AriaHidden(true)], []),
      "Henter profilen …",
    ],
  );

const failureState = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.match(model.profile, {
    onFailure: (error) =>
      h.section(
        [h.Class("fk-error"), h.Role("alert")],
        [h.h2([], ["Profilen kunne ikke hentes"]), h.p([], [error.message])],
      ),
    onStale: ({ data }) => successfulProfile(model, data, h),
    onSuccess: (data) => successfulProfile(model, data, h),
    onIdle: () => loadingState(h),
    onLoading: () => loadingState(h),
    onRefreshing: (data) => successfulProfile(model, data, h),
  });

const successfulProfile = (
  model: Model,
  observation: { firstName: string; lastName: string; role: string },
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class("fk-profile-card"), h.AriaLabelledBy("profile-edit-heading")],
    [
      h.header([h.Class("fk-profile-card__header")], [
        h.div([], [
          h.p([h.Class("fk-eyebrow")], ["Min profil"]),
          h.h1([h.Id("profile-edit-heading")], ["Rediger profil"]),
          h.p([h.Class("fk-lead")], [
            `Registrert navn: ${observation.firstName} ${observation.lastName}`.trim() + ".",
          ]),
        ]),
      ]),
      profileForm(model, h),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("fk-profile"), h.AriaLabelledBy("profile-edit-heading")],
    [failureOrContent(model, h)],
  );

const failureOrContent = (model: Model, h: HtmlBuilder<Message>): Html => {
  void OpenedProfileEditor;
  return failureState(model, h);
};
