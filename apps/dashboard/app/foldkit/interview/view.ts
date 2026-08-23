import { Button, Input } from "@foldkit/ui";
import type { Interview, InterviewSchedulingStatus } from "@vektorprogrammet/sdk/effect";
import { AsyncData, FieldValidation } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  ConfirmedCandidate,
  OpenedSchedule,
  RejectedCandidate,
  RequestedNewTimeCandidate,
  SubmittedSchedule,
  UpdatedCampus,
  UpdatedDatetime,
  UpdatedFrom,
  UpdatedMapLink,
  UpdatedMessage,
  UpdatedResponseMessage,
  UpdatedRoom,
  UpdatedTo,
  type Message,
} from "./message";
import type { Model } from "./model";

const statusLabel = (status: InterviewSchedulingStatus): string => {
  switch (status) {
    case "created":
      return "Ikke planlagt";
    case "pending":
      return "Invitert";
    case "accepted":
      return "Akseptert";
    case "request_new_time":
      return "Ønsker nytt tidspunkt";
    case "cancelled":
      return "Avlyst";
    case "no_contact":
      return "Ikke oppnådd kontakt";
  }
};

const fieldError = (id: string, field: Model["datetime"], h: HtmlBuilder<Message>): Html =>
  field._tag === "Invalid"
    ? h.p(
        [h.Id(`${id}-error`), h.Class("fk-field-error"), h.Role("alert")],
        [field.errors.join(" ")],
      )
    : h.empty;

const textField = (
  config: {
    id: string;
    label: string;
    value: string;
    field: Model["datetime"];
    placeholder: string;
    onInput: (value: string) => Message;
    isDisabled: boolean;
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
            h.p([...description, h.Class("fk-field-hint")], ["Påkrevd"]),
            fieldError(config.id, config.field, h),
          ],
        ),
    },
    h,
  );

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
  );

const feedbackView = (feedback: string | null, h: HtmlBuilder<Message>): Html =>
  feedback === null
    ? h.empty
    : h.div([h.Class("fk-feedback"), h.Role("status"), h.AriaLive("polite")], [feedback]);

const statusPill = (status: InterviewSchedulingStatus, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class(`fk-status fk-status--${status}`)], [statusLabel(status)]);

const scheduleForm = (model: Model, interview: Interview, h: HtmlBuilder<Message>): Html => {
  if (model.selectedInterviewId !== interview.id) return h.empty;
  if (interview.schedulingStatus !== "created") {
    return h.div(
      [h.Class("fk-inline-note")],
      ["Intervjuet kan ikke planlegges på nytt i denne tilstanden."],
    );
  }

  return h.form(
    [
      h.Class("fk-schedule-form"),
      h.OnSubmit(SubmittedSchedule()),
      h.AriaLabelledBy(`schedule-title-${interview.id}`),
    ],
    [
      h.div(
        [h.Class("fk-section-heading")],
        [
          h.h3([h.Id(`schedule-title-${interview.id}`)], ["Planlegg intervju"]),
          h.p(
            [],
            ["Fyll ut tid, sted og meldingsfeltene. Kandidaten får en invitasjon når du lagrer."],
          ),
        ],
      ),
      h.div(
        [h.Class("fk-form-grid")],
        [
          textField(
            {
              id: `datetime-${interview.id}`,
              label: "Tidspunkt",
              value: model.datetime.value,
              field: model.datetime,
              placeholder: "2026-09-14T15:00:00+02:00",
              onInput: (value) => UpdatedDatetime({ value }),
              isDisabled: model.isScheduling,
            },
            h,
          ),
          textField(
            {
              id: `room-${interview.id}`,
              label: "Rom",
              value: model.room.value,
              field: model.room,
              placeholder: "Rom 2",
              onInput: (value) => UpdatedRoom({ value }),
              isDisabled: model.isScheduling,
            },
            h,
          ),
          textField(
            {
              id: `campus-${interview.id}`,
              label: "Campus",
              value: model.campus.value,
              field: model.campus,
              placeholder: "Gløshaugen",
              onInput: (value) => UpdatedCampus({ value }),
              isDisabled: model.isScheduling,
            },
            h,
          ),
          textField(
            {
              id: `map-link-${interview.id}`,
              label: "Kartlenke",
              value: model.mapLink.value,
              field: model.mapLink,
              placeholder: "https://maps.example.com/…",
              onInput: (value) => UpdatedMapLink({ value }),
              isDisabled: model.isScheduling,
            },
            h,
          ),
          textField(
            {
              id: `from-${interview.id}`,
              label: "Avsender",
              value: model.from.value,
              field: model.from,
              placeholder: "intervjuer@example.com",
              onInput: (value) => UpdatedFrom({ value }),
              isDisabled: model.isScheduling,
            },
            h,
          ),
          textField(
            {
              id: `to-${interview.id}`,
              label: "Mottaker",
              value: model.to.value,
              field: model.to,
              placeholder: "søker@example.com",
              onInput: (value) => UpdatedTo({ value }),
              isDisabled: model.isScheduling,
            },
            h,
          ),
          textField(
            {
              id: `message-${interview.id}`,
              label: "Melding",
              value: model.message.value,
              field: model.message,
              placeholder: "Vi ser frem til å møte deg.",
              onInput: (value) => UpdatedMessage({ value }),
              isDisabled: model.isScheduling,
            },
            h,
          ),
        ],
      ),
      h.div(
        [h.Class("fk-actions")],
        [
          actionButton(
            model.isScheduling ? "Lagrer …" : "Lagre og send",
            SubmittedSchedule(),
            model.isScheduling,
            h,
          ),
        ],
      ),
    ],
  );
};

const interviewDetails = (interview: Interview, h: HtmlBuilder<Message>): Html => {
  if (interview.interviewTime === null || interview.room === null || interview.campus === null)
    return h.empty;
  return h.dl(
    [h.Class("fk-details")],
    [
      h.div([], [h.dt([], ["Tidspunkt"]), h.dd([], [interview.interviewTime])]),
      h.div([], [h.dt([], ["Rom"]), h.dd([], [interview.room])]),
      h.div([], [h.dt([], ["Campus"]), h.dd([], [interview.campus])]),
      h.div(
        [],
        [h.dt([], ["Intervjuer"]), h.dd([], [interview.interviewerName ?? "Ikke oppgitt"])],
      ),
    ],
  );
};
const interviewCard = (model: Model, interview: Interview, h: HtmlBuilder<Message>): Html =>
  h.article(
    [h.Class("fk-interview"), h.AriaLabelledBy(`applicant-${interview.id}`)],
    [
      h.div(
        [h.Class("fk-interview__header")],
        [
          h.div(
            [],
            [
              h.p([h.Class("fk-eyebrow")], ["Tildelt søker"]),
              h.h3([h.Id(`applicant-${interview.id}`)], [interview.applicantName]),
            ],
          ),
          statusPill(interview.schedulingStatus, h),
        ],
      ),
      interviewDetails(interview, h),
      interview.schedulingStatus === "created"
        ? h.div(
            [h.Class("fk-actions")],
            [
              actionButton(
                "Planlegg intervju",
                OpenedSchedule({ interviewId: interview.id }),
                model.isScheduling,
                h,
                "secondary",
              ),
            ],
          )
        : h.empty,
      scheduleForm(model, interview, h),
    ],
  );

const successInterviews = (
  model: Model,
  interviews: ReadonlyArray<Interview>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class("fk-results"), h.AriaLabelledBy("assigned-applicants-heading")],
    [
      h.div(
        [h.Class("fk-section-heading")],
        [
          h.p([h.Class("fk-eyebrow")], ["Opptak · Intervjuer"]),
          h.h2([h.Id("assigned-applicants-heading")], ["Tildelte søkere"]),
          h.p([], [interviews.length === 1 ? "1 søker." : `${interviews.length} søkere.`]),
        ],
      ),
      interviews.length === 0
        ? h.div(
            [h.Class("fk-empty")],
            [
              h.h3([], ["Ingen tildelte søkere"]),
              h.p([], ["Det finnes ingen tildelte søkere for ditt opptak."]),
            ],
          )
        : h.div(
            [h.Class("fk-interview-list")],
            interviews.map((interview) => interviewCard(model, interview, h)),
          ),
    ],
  );

const interviewsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.match(model.interviews, {
    onIdle: () => h.div([h.Class("fk-guidance")], [h.p([], ["Henter tildelte søkere …"])]),
    onLoading: () =>
      h.div(
        [h.Class("fk-loading"), h.Role("status"), h.AriaLive("polite")],
        [
          h.span([h.Class("fk-spinner"), h.AriaHidden(true)], []),
          h.span([], ["Henter tildelte søkere …"]),
        ],
      ),
    onRefreshing: (interviews) => successInterviews(model, interviews, h),
    onFailure: (error) =>
      h.div(
        [h.Class("fk-error"), h.Role("alert")],
        [h.h2([], ["Kunne ikke hente søkere"]), h.p([], [error])],
      ),
    onStale: ({ error }) =>
      h.div(
        [h.Class("fk-error"), h.Role("alert")],
        [h.h2([], ["Kunne ikke oppdatere søkerne"]), h.p([], [error])],
      ),
    onSuccess: (interviews) => successInterviews(model, interviews, h),
  });

const dashboardView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("foldkit-interview foldkit-interview--dashboard")],
    [
      h.header(
        [h.Class("fk-page-header")],
        [
          h.p([h.Class("fk-eyebrow")], ["Opptak · Intervjuer"]),
          h.h1([], ["Planlegg intervjuer"]),
          h.p(
            [h.Class("fk-lead")],
            ["Tildelte søkere fra Symfony. Planlegg tid, sted og send invitasjonen."],
          ),
        ],
      ),
      feedbackView(model.feedback, h),
      interviewsView(model, h),
    ],
  );

const candidateSuccess = (model: Model, h: HtmlBuilder<Message>): Html => {
  const candidate = AsyncData.getData(model.candidate);
  if (candidate._tag === "None") return h.empty;
  const status = candidate.value.schedulingStatus;
  const isPending = status === "pending";
  const isAccepted = status === "accepted";
  const isRejected = status === "cancelled";
  const isRequestingNewTime = status === "request_new_time";
  const isResponding = model.isConfirming || model.isRejecting || model.isRequestingNewTime;
  const canRespond = isPending && !isResponding;
  const heading = isAccepted
    ? "Intervjutiden er akseptert"
    : isRejected
      ? "Intervjuinvitasjonen er avvist"
      : isRequestingNewTime
        ? "Nytt tidspunkt er ønsket"
        : "Svar på intervjutid";
  const lead = isAccepted
    ? "Takk. Vi har registrert svaret ditt."
    : isRejected
      ? "Vi har registrert at du ikke kan delta."
      : isRequestingNewTime
        ? "Vi tar kontakt når vi har funnet et nytt tidspunkt."
        : "Se over tidspunkt og sted før du svarer på invitasjonen.";
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
          h.div([], [h.dt([], ["Campus"]), h.dd([], [candidate.value.campus ?? "Ikke oppgitt"])]),
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
  );
};

const candidateView = (model: Model, h: HtmlBuilder<Message>): Html =>
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
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.mode === "dashboard" ? dashboardView(model, h) : candidateView(model, h);
