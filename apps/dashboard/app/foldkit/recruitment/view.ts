import {
  InterviewSchemaId,
  type RecruitmentAssignmentBoard,
  RecruitmentInterviewerOptionSchema,
} from "@vektorprogrammet/domain/recruitment";
import { Button, Dialog, Select } from "@foldkit/ui";
import { Schema as S } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  ClosedAssignment,
  GotAssignmentDialogMessage,
  OpenedAssignment,
  SelectedFilter,
  SelectedInterviewer,
  SelectedSchema,
  SubmittedAssignment,
  type Message,
} from "./message";
import type { ReadyModel, Model } from "./model";

const dateTime = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "medium",
  timeStyle: "short",
});

type AssignmentBoard = RecruitmentAssignmentBoard;
const decodeInterviewerPersonId = S.decodeUnknownSync(
  RecruitmentInterviewerOptionSchema.fields.personId,
);
const decodeInterviewSchemaId = S.decodeUnknownSync(InterviewSchemaId);

type Candidate = AssignmentBoard["candidates"][number];

const actionButton = (
  label: string,
  message: Message,
  isDisabled: boolean,
  className: string,
  h: HtmlBuilder<Message>,
  isPressed: boolean | null = null,
): Html =>
  Button.view(
    {
      type: "button",
      onClick: message,
      isDisabled,
      toView: ({ button }) =>
        h.button(
          [
            ...button,
            h.Class(className),
            ...(isPressed === null ? [] : [h.AriaPressed(String(isPressed))]),
          ],
          [label],
        ),
    },
    h,
  );

const filterView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  h.fieldset(
    [h.Class("fr-filter"), h.Disabled(model.isAssigning)],
    [
      h.legend([h.Class("fr-filter__legend")], ["Vis søkere"]),
      h.div(
        [h.Class("fr-filter__options")],
        (
          [
            ["new", "Nye søkere"],
            ["all", "Alle søkere"],
          ] as const
        ).map(([status, label]) =>
          actionButton(
            label,
            SelectedFilter({ status }),
            model.isAssigning,
            `fr-button fr-filter__button${model.selectedFilter === status ? " is-active" : ""}`,
            h,
            model.selectedFilter === status,
          ),
        ),
      ),
    ],
  );

const candidateRow = (model: ReadyModel, candidate: Candidate, h: HtmlBuilder<Message>): Html =>
  h.tr(
    [h.DataAttribute("application-id", candidate.applicationId)],
    [
      h.th(
        [h.Scope("row")],
        [h.strong([], [`${candidate.firstName} ${candidate.lastName}`.trim()])],
      ),
      h.td([], [h.a([h.Href(`mailto:${candidate.email}`)], [candidate.email])]),
      h.td([], [h.span([h.Class("fr-status")], ["Mottatt"])]),
      h.td(
        [],
        [
          h.span(
            [
              h.Class(
                `fr-status fr-status--${candidate.interviewState === "Unassigned" ? "unassigned" : "assigned"}`,
              ),
            ],
            [candidate.interviewState === "Unassigned" ? "Ikke tildelt" : "Ikke kontaktet"],
          ),
        ],
      ),
      h.td([], [candidate.interviewer?.displayName ?? "Ikke tildelt"]),
      h.td(
        [],
        [
          candidate.scheduledAt === null
            ? "Ikke planlagt"
            : h.time(
                [h.Datetime(candidate.scheduledAt)],
                [dateTime.format(new Date(candidate.scheduledAt))],
              ),
        ],
      ),
      h.td(
        [],
        [
          candidate.interviewState === "Unassigned"
            ? actionButton(
                `Tildel intervju til ${candidate.firstName} ${candidate.lastName}`,
                OpenedAssignment({ applicationId: candidate.applicationId }),
                model.isAssigning,
                "fr-button fr-button--secondary fr-button--compact",
                h,
              )
            : h.span([h.Class("fr-assigned-note")], ["Tildelt"]),
        ],
      ),
    ],
  );

const successfulBoard = (
  model: ReadyModel,
  board: AssignmentBoard,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class("fr-board"), h.AriaLabelledBy("fr-board-title")],
    [
      h.div(
        [h.Class("fr-board__heading")],
        [
          h.div(
            [],
            [
              h.h2([h.Id("fr-board-title")], ["Søkeroversikt"]),
              h.p(
                [],
                [
                  board.candidates.length === 1
                    ? "1 søker i oversikten."
                    : `${board.candidates.length} søkere i oversikten.`,
                ],
              ),
            ],
          ),
          h.p([h.Class("fr-board__department")], [board.departmentId]),
        ],
      ),
      board.candidates.length === 0
        ? h.div(
            [h.Class("fr-empty")],
            [
              h.h3([], [model.selectedFilter === "new" ? "Ingen nye søkere" : "Ingen søkere"]),
              h.p(
                [],
                [
                  model.selectedFilter === "new"
                    ? "Alle søkerne er tildelt. Velg «Alle søkere» for å se dem."
                    : "Det finnes ingen søkere i den aktive opptaksperioden.",
                ],
              ),
            ],
          )
        : h.div(
            [
              h.Class("fr-table-scroll"),
              h.Tabindex(0),
              h.AriaLabel("Søkeroversikt, bla sidelengs"),
            ],
            [
              h.table(
                [h.Class("fr-table")],
                [
                  h.caption([h.Class("fd-visually-hidden")], ["Søkere og intervjutildeling"]),
                  h.thead(
                    [],
                    [
                      h.tr(
                        [],
                        [
                          "Navn",
                          "E-post",
                          "Søknad",
                          "Intervju",
                          "Intervjuer",
                          "Tidspunkt",
                          "Handling",
                        ].map((label) => h.th([h.Scope("col")], [label])),
                      ),
                    ],
                  ),
                  h.tbody(
                    [],
                    board.candidates.map((candidate) => candidateRow(model, candidate, h)),
                  ),
                ],
              ),
            ],
          ),
    ],
  );

const boardView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  AsyncData.match(model.board, {
    onIdle: () =>
      h.div(
        [h.Class("fr-loading"), h.Role("status"), h.AriaLive("polite")],
        ["Forbereder søkeroversikten …"],
      ),
    onLoading: () =>
      h.div(
        [h.Class("fr-loading"), h.Role("status"), h.AriaLive("polite")],
        [h.span([h.Class("fr-spinner"), h.AriaHidden(true)], []), "Henter søkeroversikten …"],
      ),
    onRefreshing: (board) => successfulBoard(model, board, h),
    onFailure: (error) =>
      h.section(
        [h.Class("fr-error"), h.Role("alert")],
        [h.h2([], ["Søkeroversikten kunne ikke hentes"]), h.p([], [error])],
      ),
    onStale: ({ error }) =>
      h.section(
        [h.Class("fr-error"), h.Role("alert")],
        [h.h2([], ["Søkeroversikten kunne ikke oppdateres"]), h.p([], [error])],
      ),
    onSuccess: (board) => successfulBoard(model, board, h),
  });

const assignmentDialogView = (model: ReadyModel, h: HtmlBuilder<Message>): Html => {
  const board = AsyncData.getData(model.board);
  const interviewers: AssignmentBoard["interviewers"] =
    board._tag === "Some" ? board.value.interviewers : [];
  const interviewSchemas: AssignmentBoard["interviewSchemas"] =
    board._tag === "Some" ? board.value.interviewSchemas : [];
  const candidate =
    board._tag === "Some" && model.selectedApplicationId !== null
      ? board.value.candidates.find((item) => item.applicationId === model.selectedApplicationId)
      : undefined;

  return h.submodel({
    slotId: model.assignmentDialog.id,
    model: model.assignmentDialog,
    view: Dialog.view,
    viewInputs: {
      toView: ({ dialog, backdrop, panel, title, description, isVisible }) =>
        h.dialog(
          [...dialog, h.Class("fr-dialog")],
          isVisible && candidate !== undefined
            ? [
                h.div([...backdrop, h.Class("fr-dialog__backdrop")]),
                h.div(
                  [...panel, h.Class("fr-dialog__panel")],
                  [
                    h.div(
                      [h.Class("fr-dialog__heading")],
                      [
                        h.p([h.Class("fr-eyebrow")], ["Intervjutildeling"]),
                        h.h2(
                          [...title],
                          [`Tildel intervju til ${candidate.firstName} ${candidate.lastName}`],
                        ),
                        h.p(
                          [...description],
                          ["Velg en aktiv intervjuer og et aktivt intervjuskjema."],
                        ),
                      ],
                    ),
                    model.assignmentError === null
                      ? h.empty
                      : h.p(
                          [h.Class("fr-error fr-error--inline"), h.Role("alert")],
                          [model.assignmentError],
                        ),
                    h.form(
                      [
                        h.Class("fr-dialog__form"),
                        h.OnSubmit(SubmittedAssignment()),
                        h.AriaBusy(model.isAssigning),
                      ],
                      [
                        Select.view(
                          {
                            id: "fr-interviewer",
                            value: model.selectedInterviewerPersonId ?? "",
                            isDisabled: model.isAssigning,
                            isInvalid:
                              model.assignmentError !== null &&
                              model.selectedInterviewerPersonId === null,
                            onChange: (personId) =>
                              SelectedInterviewer({
                                personId: decodeInterviewerPersonId(personId),
                              }),
                            toView: ({ select, label }) =>
                              h.div(
                                [h.Class("fr-field")],
                                [
                                  h.label([...label, h.Class("fr-label")], ["Intervjuer"]),
                                  h.select(
                                    [...select, h.Class("fr-select")],
                                    [
                                      h.option(
                                        [h.Value(""), h.Disabled(true)],
                                        ["Velg intervjuer"],
                                      ),
                                      ...interviewers.map((option) =>
                                        h.option([h.Value(option.personId)], [option.displayName]),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                          },
                          h,
                        ),
                        Select.view(
                          {
                            id: "fr-interview-schema",
                            value: model.selectedInterviewSchemaId ?? "",
                            isDisabled: model.isAssigning,
                            isInvalid:
                              model.assignmentError !== null &&
                              model.selectedInterviewSchemaId === null,
                            onChange: (interviewSchemaId) =>
                              SelectedSchema({
                                interviewSchemaId: decodeInterviewSchemaId(interviewSchemaId),
                              }),
                            toView: ({ select, label }) =>
                              h.div(
                                [h.Class("fr-field")],
                                [
                                  h.label([...label, h.Class("fr-label")], ["Intervjuskjema"]),
                                  h.select(
                                    [...select, h.Class("fr-select")],
                                    [
                                      h.option(
                                        [h.Value(""), h.Disabled(true)],
                                        ["Velg intervjuskjema"],
                                      ),
                                      ...interviewSchemas
                                        .filter((option) => option.active)
                                        .map((option) =>
                                          h.option(
                                            [h.Value(option.interviewSchemaId)],
                                            [`${option.name} (${option.questionCount} spørsmål)`],
                                          ),
                                        ),
                                    ],
                                  ),
                                ],
                              ),
                          },
                          h,
                        ),
                        h.div(
                          [h.Class("fr-dialog__actions")],
                          [
                            actionButton(
                              "Avbryt",
                              ClosedAssignment(),
                              model.isAssigning,
                              "fr-button fr-button--secondary",
                              h,
                            ),
                            actionButton(
                              model.isAssigning ? "Tildeler …" : "Tildel intervju",
                              SubmittedAssignment(),
                              model.isAssigning,
                              "fr-button fr-button--primary",
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
    toParentMessage: (message) => GotAssignmentDialogMessage({ message }),
  });
};
const readyView = (model: ReadyModel, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("foldkit-recruitment"), h.AriaLabelledBy("fr-page-title")],
    [
      h.header(
        [h.Class("fr-page-header")],
        [
          h.p([h.Class("fr-eyebrow")], ["Opptak · Søkere"]),
          h.h1([h.Id("fr-page-title")], ["Søkere"]),
          h.p([], ["Se søknadsstatus og tildel intervju uten å forlate oversikten."]),
        ],
      ),
      model.feedback === null
        ? h.empty
        : h.p(
            [h.Class("fr-feedback fr-feedback--success"), h.Role("status"), h.AriaLive("polite")],
            [model.feedback],
          ),
      filterView(model, h),
      boardView(model, h),
      assignmentDialogView(model, h),
    ],
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  model._tag === "Ready"
    ? readyView(model, h)
    : h.section(
        [h.Class("foldkit-recruitment fr-error fr-error--fatal"), h.Role("alert")],
        [
          h.h1([], ["Søkeroversikten kunne ikke startes"]),
          h.p([], ["Last siden på nytt og prøv igjen."]),
        ],
      );
