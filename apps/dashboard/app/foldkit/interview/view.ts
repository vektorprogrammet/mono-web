import { Button, Input } from "@foldkit/ui"
import { AsyncData, FieldValidation } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { invitationFailureMessage, type InvitationResponseObservation } from "./bridge"
import {
  ConfirmedInvitation,
  RejectedInvitation,
  RequestedNewInvitationTime,
  UpdatedResponseMessage,
  type Message,
} from "./message"
import type { Model } from "./model"

const statusLabel = (status: InvitationResponseObservation["responseState"]): string => {
  switch (status) {
    case "Pending":
      return "Venter på svar"
    case "Accepted":
      return "Akseptert"
    case "Rejected":
      return "Avvist"
    case "RequestedNewTime":
      return "Ønsker nytt tidspunkt"
  }
}

const statusClass = (status: InvitationResponseObservation["responseState"]): string => {
  switch (status) {
    case "Pending":
      return "pending"
    case "Accepted":
      return "accepted"
    case "Rejected":
      return "rejected"
    case "RequestedNewTime":
      return "requested-new-time"
  }
}

const formatInstant = (instant: string): string => {
  const parsed = new Date(instant)
  if (!Number.isFinite(parsed.getTime())) return instant
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(parsed)
}

const fieldError = (id: string, field: Model["responseMessage"], h: HtmlBuilder<Message>): Html =>
  field._tag === "Invalid"
    ? h.p(
        [h.Id(`${id}-error`), h.Class("fk-field-error"), h.Role("alert")],
        [field.errors.join(" ")],
      )
    : h.empty

const textField = (
  config: {
    id: string
    value: string
    field: Model["responseMessage"]
    isDisabled: boolean
  },
  h: HtmlBuilder<Message>,
): Html =>
  Input.view(
    {
      id: config.id,
      value: config.value,
      onInput: (value) => UpdatedResponseMessage({ value }),
      placeholder: "Skriv en melding hvis du ikke kan møte eller trenger et annet tidspunkt.",
      isDisabled: config.isDisabled,
      isInvalid: FieldValidation.isInvalid(config.field),
      toView: ({ input, label, description }) =>
        h.div(
          [h.Class("fk-field")],
          [
            h.label([...label, h.Class("fk-label")], ["Melding"]),
            h.input([...input, h.Class("fk-input")]),
            h.p([...description, h.Class("fk-field-hint")], [
              "Valgfritt når du avviser. Påkrevd når du ber om nytt tidspunkt.",
            ]),
            fieldError(config.id, config.field, h),
          ],
        ),
    },
    h,
  )

const actionButton = (
  label: string,
  message: Message,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
  variant: "primary" | "secondary" = "primary",
): Html =>
  Button.view(
    {
      onClick: message,
      isDisabled,
      type: "button",
      toView: ({ button }) =>
        h.button([...button, h.Class(`fk-button fk-button--${variant}`)], [label]),
    },
    h,
  )

const statusPill = (
  status: InvitationResponseObservation["responseState"],
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Class(`fk-status fk-status--${statusClass(status)}`)],
    [statusLabel(status)],
  )

const invitationSuccess = (model: Model, h: HtmlBuilder<Message>): Html => {
  const current = AsyncData.getData(model.invitationResponse)
  if (current._tag === "None") return h.empty
  const observation = current.value
  const isPending = observation.responseState === "Pending"
  const isResponding = model.selectedAction !== null
  const heading = observation.responseState === "Accepted"
    ? "Intervjutiden er akseptert"
    : observation.responseState === "Rejected"
      ? "Intervjuinvitasjonen er avvist"
      : observation.responseState === "RequestedNewTime"
        ? "Nytt tidspunkt er ønsket"
        : "Svar på intervjutid"
  const lead = observation.responseState === "Accepted"
    ? "Takk. Vi har registrert svaret ditt."
    : observation.responseState === "Rejected"
      ? "Vi har registrert at du ikke kan delta."
      : observation.responseState === "RequestedNewTime"
        ? "Vi tar kontakt når vi har funnet et nytt tidspunkt."
        : "Se over tidspunkt og sted før du svarer på invitasjonen."

  return h.article(
    [h.Class("fk-response-card"), h.AriaLabelledBy("response-heading")],
    [
      h.div(
        [h.Class("fk-response-card__header")],
        [
          h.div(
            [],
            [
              h.p([h.Class("fk-eyebrow")], ["Intervjuinvitasjon"]),
              h.h1([h.Id("response-heading")], [heading]),
            ],
          ),
          statusPill(observation.responseState, h),
        ],
      ),
      h.p([h.Class("fk-lead")], [lead]),
      h.dl(
        [h.Class("fk-details fk-details--candidate")],
        [
          h.div(
            [],
            [h.dt([], ["Tidspunkt"]), h.dd([], [formatInstant(observation.scheduledAt)])],
          ),
          h.div([], [h.dt([], ["Rom"]), h.dd([], [observation.room])]),
          h.div([], [
            h.dt([], ["Campus"]),
            h.dd([], [observation.campus ?? "Ikke oppgitt"]),
          ]),
          observation.responseMessage === null ||
          (
            observation.responseState !== "Rejected" &&
            observation.responseState !== "RequestedNewTime"
          )
            ? h.empty
            : h.div([], [
                h.dt([], ["Melding"]),
                h.dd([], [observation.responseMessage]),
              ]),
        ],
      ),
      isPending
        ? h.div(
            [],
            [
              textField(
                {
                  id: "response-message",
                  value: model.responseMessage.value,
                  field: model.responseMessage,
                  isDisabled: isResponding,
                },
                h,
              ),
              h.div(
                [h.Class("fk-actions")],
                [
                  actionButton(
                    model.selectedAction === "Confirm"
                      ? "Registrerer svar …"
                      : "Bekreft intervjutid",
                    ConfirmedInvitation(),
                    isResponding,
                    h,
                  ),
                  actionButton(
                    model.selectedAction === "Reject" ? "Registrerer svar …" : "Avvis intervju",
                    RejectedInvitation(),
                    isResponding,
                    h,
                    "secondary",
                  ),
                  actionButton(
                    model.selectedAction === "RequestNewTime"
                      ? "Registrerer svar …"
                      : "Be om nytt tidspunkt",
                    RequestedNewInvitationTime(),
                    isResponding,
                    h,
                    "secondary",
                  ),
                ],
              ),
            ],
          )
        : h.div(
            [h.Class("fk-confirmation"), h.Role("status")],
            ["Svaret er registrert. Du trenger ikke gjøre noe mer."],
          ),
    ],
  )
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.main(
    [h.Class("foldkit-interview foldkit-interview--candidate")],
    [
      AsyncData.match(model.invitationResponse, {
        onIdle: () =>
          h.div([h.Class("fk-loading"), h.Role("status")], ["Forbereder invitasjonen …"]),
        onLoading: () =>
          h.div(
            [h.Class("fk-loading"), h.Role("status"), h.AriaLive("polite")],
            [
              h.span([h.Class("fk-spinner"), h.AriaHidden(true)], []),
              h.span([], ["Henter intervjutid …"]),
            ],
          ),
        onRefreshing: () => invitationSuccess(model, h),
        onFailure: (failure) =>
          h.section(
            [h.Class("fk-error fk-error--candidate"), h.Role("alert")],
            [
              h.p([h.Class("fk-eyebrow")], ["Intervjuinvitasjon"]),
              h.h1([], ["Invitasjonen er ikke tilgjengelig"]),
              h.p([], [invitationFailureMessage(failure)]),
            ],
          ),
        onStale: ({ error }) =>
          h.section(
            [h.Class("fk-error fk-error--candidate"), h.Role("alert")],
            [h.h1([], ["Kunne ikke oppdatere svaret"]), h.p([], [invitationFailureMessage(error)])],
          ),
        onSuccess: () => invitationSuccess(model, h),
      }),
      model.validationFeedback === null
        ? h.empty
        : h.div([h.Class("fk-feedback fk-feedback--error"), h.Role("alert")], [
            model.validationFeedback,
          ]),
      model.failure === null
        ? h.empty
        : h.div([h.Class("fk-feedback fk-feedback--error"), h.Role("alert")], [
            invitationFailureMessage(model.failure),
          ]),
    ],
  )
