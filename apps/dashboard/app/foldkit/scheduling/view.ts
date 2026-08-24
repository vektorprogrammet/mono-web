import type {
  RecruitmentSchedulingBoard,
  RecruitmentSchedulingInterview,
} from "@vektorprogrammet/sdk/effect";
import { Button, Dialog, Input } from "@foldkit/ui";
import { AsyncData, FieldValidation } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  ClosedSchedule,
  GotScheduleDialogMessage,
  OpenedSchedule,
  RequestedBoardRefresh,
  SubmittedSchedule,
  UpdatedCampus,
  UpdatedMapLink,
  UpdatedMessage,
  UpdatedRoom,
  UpdatedScheduledAt,
  type Message,
} from "./message";
import type { Model, ReadyModel } from "./model";

const fieldError = (id: string, field: ReadyModel["scheduledAt"], h: HtmlBuilder<Message>): Html =>
  field._tag === "Invalid"
    ? h.p(
        [h.Id(`${id}-error`), h.Class("fs-field-error"), h.Role("alert")],
        [field.errors.join(" ")],
      )
    : h.empty;

const textField = (
  config: {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly field: ReadyModel["scheduledAt"];
    readonly hint: string;
    readonly placeholder: string;
    readonly onInput: (value: string) => Message;
    readonly isDisabled: boolean;
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
          [h.Class("fs-field")],
          [
            h.label([...label, h.Class("fs-label")], [config.label]),
            h.input([...input, h.Class("fs-input")]),
            h.p([...description, h.Class("fs-field-hint")], [config.hint]),
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
  className: string,
  h: HtmlBuilder<Message>,
): Html =>
  Button.view(
    {
      onClick: message,
      isDisabled,
      type: "button",
      toView: ({ button }) => h.button([...button, h.Class(className)], [label]),
    },
    h,
  );

const formatInstant = (instant: string): string => {
  const parsed = new Date(instant);
  if (!Number.isFinite(parsed.getTime())) return instant;
  return new Intl.DateTimeFormat("nb-NO", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(parsed);
};

export const responseLabel = (state: RecruitmentSchedulingInterview["responseState"]): string => {
  switch (state) {
    case "Pending":
      return "Venter på svar";
    case "Accepted":
      return "Akseptert";
    case "Rejected":
      return "Avvist";
    case "RequestedNewTime":
      return "Ønsker nytt tidspunkt";
    case null:
      return "Ikke invitert";
  }
};

const notificationLabel = (state: RecruitmentSchedulingInterview["notificationState"]): string => {
  switch (state) {
    case "Pending":
      return "Lagt i kø";
    case "Processing":
      return "Behandles";
    case "Delivered":
      return "Levert";
    case "Failed":
      return "Levering feilet";
    case "Quarantined":
      return "Krever oppfølging";
    case null:
      return "Ikke opprettet";
  }
};

const scheduleDetails = (
  interview: RecruitmentSchedulingInterview,
  h: HtmlBuilder<Message>,
): Html => {
  if (interview.schedule === null) {
    return h.p([h.Class("fs-unscheduled")], ["Intervjuet har ikke fått tid og sted ennå."]);
  }

  return h.dl(
    [h.Class("fs-details")],
    [
      h.div(
        [],
        [h.dt([], ["Tidspunkt"]), h.dd([], [formatInstant(interview.schedule.scheduledAt)])],
      ),
      h.div([], [h.dt([], ["Rom"]), h.dd([], [interview.schedule.room])]),
      h.div([], [h.dt([], ["Campus"]), h.dd([], [interview.schedule.campus ?? "Ikke oppgitt"])]),
      h.div(
        [],
        [h.dt([], ["Kartlenke"]), h.dd([], [interview.schedule.mapLink ?? "Ikke oppgitt"])],
      ),
      h.div([], [h.dt([], ["Svar fra søker"]), h.dd([], [responseLabel(interview.responseState)])]),
      ...(interview.responseMessage === null ||
      (interview.responseState !== "Rejected" && interview.responseState !== "RequestedNewTime")
        ? []
        : [h.div([], [h.dt([], ["Melding fra søker"]), h.dd([], [interview.responseMessage])])]),
      h.div(
        [],
        [h.dt([], ["Invitasjon"]), h.dd([], [notificationLabel(interview.notificationState)])],
      ),
    ],
  );
};

const interviewCard = (
  model: ReadyModel,
  interview: RecruitmentSchedulingInterview,
  index: number,
  h: HtmlBuilder<Message>,
): Html => {
  const applicantName = `${interview.applicant.firstName} ${interview.applicant.lastName}`.trim();
  const isScheduled = interview.schedule !== null;
  return h.article(
    [h.Class("fs-interview"), h.AriaLabelledBy(`fs-applicant-${index}`)],
    [
      h.div(
        [h.Class("fs-interview__header")],
        [
          h.div(
            [],
            [
              h.p([h.Class("fs-eyebrow")], ["Tildelt søker"]),
              h.h3([h.Id(`fs-applicant-${index}`)], [applicantName]),
              h.p(
                [h.Class("fs-interviewer")],
                [`Intervjuer: ${interview.interviewer.displayName}`],
              ),
            ],
          ),
          h.span(
            [h.Class(`fs-status ${isScheduled ? "fs-status--scheduled" : "fs-status--open"}`)],
            [isScheduled ? "Planlagt" : "Ikke planlagt"],
          ),
        ],
      ),
      h.dl(
        [h.Class("fs-contact-grid")],
        [
          h.div([], [h.dt([], ["Søkerens e-post"]), h.dd([], [interview.applicant.email])]),
          h.div([], [h.dt([], ["Søkerens telefon"]), h.dd([], [interview.applicant.phone])]),
          h.div([], [h.dt([], ["Intervjuerens e-post"]), h.dd([], [interview.interviewer.email])]),
          h.div([], [h.dt([], ["Intervjuerens telefon"]), h.dd([], [interview.interviewer.phone])]),
        ],
      ),
      scheduleDetails(interview, h),
      isScheduled
        ? h.empty
        : h.div(
            [h.Class("fs-card-actions")],
            [
              actionButton(
                "Planlegg intervju",
                OpenedSchedule({ interviewId: interview.interviewId }),
                model.isScheduling,
                "fs-button fs-button--primary fs-button--compact",
                h,
              ),
            ],
          ),
    ],
  );
};

const successfulBoard = (
  model: ReadyModel,
  board: RecruitmentSchedulingBoard,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class("fs-board"), h.AriaLabelledBy("fs-board-title")],
    [
      h.div(
        [h.Class("fs-board__heading")],
        [
          h.div(
            [],
            [
              h.h2([h.Id("fs-board-title")], ["Intervjuer du kan planlegge"]),
              h.p(
                [],
                [
                  board.interviews.length === 1
                    ? "1 tildelt intervju."
                    : `${board.interviews.length} tildelte intervjuer.`,
                ],
              ),
            ],
          ),
          actionButton(
            "Hent oppdatert oversikt",
            RequestedBoardRefresh(),
            model.isScheduling,
            "fs-button fs-button--secondary fs-button--compact",
            h,
          ),
        ],
      ),
      board.interviews.length === 0
        ? h.div(
            [h.Class("fs-empty")],
            [
              h.h3([], ["Ingen intervjuer å planlegge"]),
              h.p([], ["Det finnes ingen tildelte intervjuer i denne oversikten."]),
            ],
          )
        : h.div(
            [h.Class("fs-interview-list")],
            board.interviews.map((interview, index) => interviewCard(model, interview, index, h)),
          ),
    ],
  );

const boardView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  AsyncData.match(model.board, {
    onIdle: () =>
      h.div(
        [h.Class("fs-loading"), h.Role("status"), h.AriaLive("polite")],
        ["Forbereder intervjuoversikten …"],
      ),
    onLoading: () =>
      h.div(
        [h.Class("fs-loading"), h.Role("status"), h.AriaLive("polite")],
        [h.span([h.Class("fs-spinner"), h.AriaHidden(true)], []), "Henter intervjuoversikten …"],
      ),
    onRefreshing: (board) => successfulBoard(model, board, h),
    onFailure: (error) =>
      h.section(
        [h.Class("fs-error"), h.Role("alert")],
        [
          h.h2([], ["Intervjuoversikten kunne ikke hentes"]),
          h.p([], [error]),
          actionButton(
            "Prøv igjen",
            RequestedBoardRefresh(),
            model.isScheduling,
            "fs-button fs-button--secondary",
            h,
          ),
        ],
      ),
    onStale: ({ error }) =>
      h.section(
        [h.Class("fs-error"), h.Role("alert")],
        [
          h.h2([], ["Intervjuoversikten kunne ikke oppdateres"]),
          h.p([], [error]),
          actionButton(
            "Prøv igjen",
            RequestedBoardRefresh(),
            model.isScheduling,
            "fs-button fs-button--secondary",
            h,
          ),
        ],
      ),
    onSuccess: (board) => successfulBoard(model, board, h),
  });

const scheduleDialogView = (model: ReadyModel, h: HtmlBuilder<Message>): Html => {
  const board = AsyncData.getData(model.board);
  const interview =
    board._tag === "Some" && model.selectedInterviewId !== null
      ? board.value.interviews.find(
          (candidate) => candidate.interviewId === model.selectedInterviewId,
        )
      : undefined;
  const applicantName =
    interview === undefined
      ? ""
      : `${interview.applicant.firstName} ${interview.applicant.lastName}`.trim();
  const mapLink = model.mapLink.value.trim();

  return h.submodel({
    slotId: model.scheduleDialog.id,
    model: model.scheduleDialog,
    view: Dialog.view,
    viewInputs: {
      toView: ({ dialog, backdrop, panel, title, description, isVisible }) =>
        h.dialog(
          [...dialog, h.Class("fs-dialog")],
          isVisible && interview !== undefined && interview.schedule === null
            ? [
                h.div([...backdrop, h.Class("fs-dialog__backdrop")]),
                h.div(
                  [...panel, h.Class("fs-dialog__panel")],
                  [
                    h.div(
                      [h.Class("fs-dialog__heading")],
                      [
                        h.p([h.Class("fs-eyebrow")], ["Intervjuplan"]),
                        h.h2([...title], [`Planlegg intervju med ${applicantName}`]),
                        h.p(
                          [...description],
                          ["Tid, sted og melding lagres før invitasjonen legges i kø."],
                        ),
                      ],
                    ),
                    h.dl(
                      [h.Class("fs-dialog__authority")],
                      [
                        h.div(
                          [],
                          [
                            h.dt([], ["Søker"]),
                            h.dd([], [`${applicantName} · ${interview.applicant.email}`]),
                          ],
                        ),
                        h.div(
                          [],
                          [
                            h.dt([], ["Tildelt intervjuer"]),
                            h.dd(
                              [],
                              [
                                `${interview.interviewer.displayName} · ${interview.interviewer.email}`,
                              ],
                            ),
                          ],
                        ),
                      ],
                    ),
                    model.scheduleError === null
                      ? h.empty
                      : h.p(
                          [h.Class("fs-error fs-error--inline"), h.Role("alert")],
                          [model.scheduleError],
                        ),
                    h.form(
                      [
                        h.Class("fs-dialog__form"),
                        h.OnSubmit(SubmittedSchedule()),
                        h.AriaBusy(model.isScheduling),
                      ],
                      [
                        textField(
                          {
                            id: "fs-scheduled-at",
                            label: "Tidspunkt",
                            value: model.scheduledAt.value,
                            field: model.scheduledAt,
                            hint: "Påkrevd. Bruk RFC 3339 med tidssone.",
                            placeholder: "2026-09-14T15:00:00+02:00",
                            onInput: (value) => UpdatedScheduledAt({ value }),
                            isDisabled: model.isScheduling,
                          },
                          h,
                        ),
                        h.div(
                          [h.Class("fs-form-grid")],
                          [
                            textField(
                              {
                                id: "fs-room",
                                label: "Rom",
                                value: model.room.value,
                                field: model.room,
                                hint: "Påkrevd.",
                                placeholder: "Rom 2",
                                onInput: (value) => UpdatedRoom({ value }),
                                isDisabled: model.isScheduling,
                              },
                              h,
                            ),
                            textField(
                              {
                                id: "fs-campus",
                                label: "Campus",
                                value: model.campus.value,
                                field: model.campus,
                                hint: "Valgfritt.",
                                placeholder: "Gløshaugen",
                                onInput: (value) => UpdatedCampus({ value }),
                                isDisabled: model.isScheduling,
                              },
                              h,
                            ),
                          ],
                        ),
                        textField(
                          {
                            id: "fs-map-link",
                            label: "Kartlenke",
                            value: model.mapLink.value,
                            field: model.mapLink,
                            hint: "Valgfritt. Må bruke HTTPS.",
                            placeholder: "https://maps.example.com/…",
                            onInput: (value) => UpdatedMapLink({ value }),
                            isDisabled: model.isScheduling,
                          },
                          h,
                        ),
                        mapLink.length === 0
                          ? h.empty
                          : h.p(
                              [h.Class("fs-map-preview"), h.Role("status")],
                              [`Kartlenke som lagres: ${mapLink}`],
                            ),
                        textField(
                          {
                            id: "fs-message",
                            label: "Melding",
                            value: model.message.value,
                            field: model.message,
                            hint: "Påkrevd. Maksimalt 2000 tegn.",
                            placeholder: "Vi ser frem til å møte deg.",
                            onInput: (value) => UpdatedMessage({ value }),
                            isDisabled: model.isScheduling,
                          },
                          h,
                        ),
                        h.p(
                          [h.Class("fs-notification-note")],
                          [
                            "Søkerens og intervjuerens kontaktopplysninger kommer fra systemet og kan ikke endres her.",
                          ],
                        ),
                        h.div(
                          [h.Class("fs-dialog__actions")],
                          [
                            actionButton(
                              "Avbryt",
                              ClosedSchedule(),
                              model.isScheduling,
                              "fs-button fs-button--secondary",
                              h,
                            ),
                            actionButton(
                              model.isScheduling
                                ? "Lagrer og henter ny oversikt …"
                                : "Lagre og legg i kø",
                              SubmittedSchedule(),
                              model.isScheduling,
                              "fs-button fs-button--primary",
                              h,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
              ]
            : [],
        ),
    },
    toParentMessage: (dialogMessage) => GotScheduleDialogMessage({ message: dialogMessage }),
  });
};

const readyView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("foldkit-scheduling"), h.AriaLabelledBy("fs-page-title")],
    [
      h.header(
        [h.Class("fs-page-header")],
        [
          h.p([h.Class("fs-eyebrow")], ["Opptak · Intervjuer"]),
          h.h1([h.Id("fs-page-title")], ["Planlegg intervjuer"]),
          h.p(
            [],
            ["Planlegg tildelte intervjuer. Invitasjonen sendes fra lagrede kontaktopplysninger."],
          ),
        ],
      ),
      model.feedback === null
        ? h.empty
        : h.div(
            [h.Class("fs-feedback fs-feedback--success"), h.Role("status"), h.AriaLive("polite")],
            [model.feedback],
          ),
      boardView(model, h),
      scheduleDialogView(model, h),
    ],
  );

const invalidInputView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("foldkit-scheduling fs-error fs-error--fatal"), h.Role("alert")],
    [
      h.h1([], ["Intervjuplanleggingen kunne ikke startes"]),
      h.p([], ["Last siden på nytt og prøv igjen."]),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  model._tag === "Ready" ? readyView(model, h) : invalidInputView(h);
