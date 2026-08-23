import { Button, Input } from "@foldkit/ui"
import type { InterviewSchedulingStatus } from "@vektorprogrammet/sdk/effect"
import { AsyncData, FieldValidation } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  ConfirmedCandidate,
  RejectedCandidate,
  RequestedNewTimeCandidate,
  UpdatedResponseMessage,
  type Message,
} from "./message"
import type { Model } from "./model"

const statusLabel = (status: InterviewSchedulingStatus): string => {
  switch (status) {
    case "created":
      return "Ikke planlagt"
    case "pending":
      return "Invitert"
    case "accepted":
      return "Akseptert"
    case "request_new_time":
      return "Ønsker nytt tidspunkt"
    case "cancelled":
      return "Avlyst"
    case "no_contact":
      return "Ikke oppnådd kontakt"
  }
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
    label: string
    value: string
    field: Model["responseMessage"]
    placeholder: string
    onInput: (value: string) => Message
    isDisabled: boolean
  },
  h: HtmlBuilder<Message>,
): Html =>
  Input.view(
    {
      id: config.id,
      value: config.value,
      onInput: config.onInput,
      placeholder: config.placeholder,
      isDisabled: config.isDisabled,
      isInvalid: FieldValidation.isInvalid(config.field),
      toView: ({ input, label, description }) =>
        h.div(
          [h.Class("fk-field")],
          [
            h.label([...label, h.Class("fk-label")], [config.label]),
            h.input([...input, h.Class("fk-input")]),
            h.p([...description, h.Class("fk-field-hint")], [
              "Valgfritt, unntatt når du ber om nytt tidspunkt.",
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

const feedbackView = (feedback: string | null, h: HtmlBuilder<Message>): Html =>
  feedback === null
    ? h.empty
    : h.div([h.Class("fk-feedback"), h.Role("status"), h.AriaLive("polite")], [feedback])

const statusPill = (status: InterviewSchedulingStatus, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class(`fk-status fk-status--${status}`)], [statusLabel(status)])

const candidateSuccess = (model: Model, h: HtmlBuilder<Message>): Html => {
  const candidate = AsyncData.getData(model.candidate)
  if (candidate._tag === "None") return h.empty
  const status = candidate.value.schedulingStatus
  const isPending = status === "pending"
  const isAccepted = status === "accepted"
  const isRejected = status === "cancelled"
  const isRequestingNewTime = status === "request_new_time"
  const isResponding = model.isConfirming || model.isRejecting || model.isRequestingNewTime
  const canRespond = isPending && !isResponding
  const heading = isAccepted
    ? "Intervjutiden er akseptert"
    : isRejected
      ? "Intervjuinvitasjonen er avvist"
      : isRequestingNewTime
        ? "Nytt tidspunkt er ønsket"
        : "Svar på intervjutid"
  const lead = isAccepted
    ? "Takk. Vi har registrert svaret ditt."
    : isRejected
      ? "Vi har registrert at du ikke kan delta."
      : isRequestingNewTime
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
          statusPill(status, h),
        ],
      ),
      h.p([h.Class("fk-lead")], [lead]),
      h.dl(
        [h.Class("fk-details fk-details--candidate")],
        [
          h.div(
            [],
            [h.dt([], ["Tidspunkt"]), h.dd([], [candidate.value.interviewTime ?? "Ikke oppgitt"])],
          ),
          h.div([], [h.dt([], ["Rom"]), h.dd([], [candidate.value.room ?? "Ikke oppgitt"])]),
          h.div([], [
            h.dt([], ["Campus"]),
            h.dd([], [candidate.value.campus ?? "Ikke oppgitt"]),
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
                  label: "Melding",
                  value: model.responseMessage.value,
                  field: model.responseMessage,
                  placeholder: "Skriv en melding hvis du trenger et annet tidspunkt.",
                  onInput: (value) => UpdatedResponseMessage({ value }),
                  isDisabled: isResponding,
                },
                h,
              ),
              h.div(
                [h.Class("fk-actions")],
                [
                  actionButton(
                    model.isConfirming ? "Registrerer svar …" : "Bekreft intervjutid",
                    ConfirmedCandidate(),
                    !canRespond,
                    h,
                  ),
                  actionButton(
                    model.isRejecting ? "Registrerer svar …" : "Avvis intervju",
                    RejectedCandidate(),
                    !canRespond,
                    h,
                    "secondary",
                  ),
                  actionButton(
                    model.isRequestingNewTime ? "Registrerer svar …" : "Be om nytt tidspunkt",
                    RequestedNewTimeCandidate(),
                    !canRespond,
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
      AsyncData.match(model.candidate, {
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
        onRefreshing: () => candidateSuccess(model, h),
        onFailure: (error) =>
          h.section(
            [h.Class("fk-error fk-error--candidate"), h.Role("alert")],
            [
              h.p([h.Class("fk-eyebrow")], ["Intervjuinvitasjon"]),
              h.h1([], ["Invitasjonen er ikke tilgjengelig"]),
              h.p([], [error]),
            ],
          ),
        onStale: ({ error }) =>
          h.section(
            [h.Class("fk-error fk-error--candidate"), h.Role("alert")],
            [h.h1([], ["Kunne ikke oppdatere svaret"]), h.p([], [error])],
          ),
        onSuccess: () => candidateSuccess(model, h),
      }),
      feedbackView(model.feedback, h),
    ],
  )
