import { Button, Input } from "@foldkit/ui";
import type { Html, HtmlBuilder } from "foldkit/html";
import { SubmittedProfile, UpdatedProfileField, type Message } from "./message";
import type { Model } from "./model";

const fieldKey = (id: string): "firstName" | "lastName" | "email" | "phone" => {
  if (id === "profile-first-name") return "firstName";
  if (id === "profile-last-name") return "lastName";
  if (id === "profile-email") return "email";
  return "phone";
};

const textField = (
  config: {
    id: string;
    label: string;
    value: string;
    field: Model["firstName"];
    isDisabled: boolean;
    hint?: string;
    type?: string;
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

const saveButton = (model: Model, h: HtmlBuilder<Message>): Html =>
  Button.view(
    {
      onClick: SubmittedProfile(),
      isDisabled: model.isSaving,
      type: "submit",
      toView: ({ button }) =>
        h.button([...button, h.Class("fk-button fk-button--primary")], [
          model.isSaving ? "Lagrer …" : "Lagre endringer",
        ]),
    },
    h,
  );

const profileForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [
      h.Class("fk-profile__form"),
      h.Attribute("novalidate", ""),
      h.OnSubmit(SubmittedProfile()),
      h.AriaBusy(model.isSaving),
    ],
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
              isDisabled: model.isSaving,
            },
            h,
          ),
          textField(
            {
              id: "profile-last-name",
              label: "Etternavn",
              value: model.lastName.value,
              field: model.lastName,
              isDisabled: model.isSaving,
            },
            h,
          ),
          textField(
            {
              id: "profile-email",
              label: "E-post",
              value: model.email.value,
              field: model.email,
              isDisabled: model.isSaving,
              type: "email",
            },
            h,
          ),
          textField(
            {
              id: "profile-phone",
              label: "Telefon",
              value: model.phone.value,
              field: model.phone,
              isDisabled: model.isSaving,
              type: "tel",
              hint: "Bruk sifre og eventuelt +, mellomrom, parentes, punktum eller bindestrek.",
            },
            h,
          ),
        ],
      ),
      model.failure === null
        ? h.empty
        : h.section(
            [h.Class("fk-feedback fk-feedback--error"), h.Role("alert")],
            [h.h2([], ["Lagringen feilet"]), h.p([], [model.failure.message])],
          ),
      model.status === null
        ? h.empty
        : h.p([h.Class("fk-feedback"), h.Role("status")], [model.status]),
      h.div(
        [h.Class("fk-actions")],
        [
          saveButton(model, h),
          h.a(
            [h.Class("fk-button fk-button--secondary"), h.Href("/dashboard/profile")],
            ["Avbryt"],
          ),
        ],
      ),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("fk-profile"), h.AriaLabelledBy("profile-edit-heading")],
    [
      h.section(
        [h.Class("fk-profile-card"), h.AriaLabelledBy("profile-edit-heading")],
        [
          h.header([h.Class("fk-profile-card__header")], [
            h.div([], [
              h.p([h.Class("fk-eyebrow")], ["Min profil"]),
              h.h1([h.Id("profile-edit-heading")], ["Rediger profil"]),
              h.p([h.Class("fk-lead")], [
                `Registrert navn: ${model.profile.firstName} ${model.profile.lastName}`.trim() +
                  ".",
              ]),
            ]),
          ]),
          profileForm(model, h),
        ],
      ),
    ],
  );
