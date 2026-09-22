import type { Html, HtmlBuilder } from "foldkit/html";
import { schoolSurveyPath } from "../../lib/school-survey-path";
import { schoolSurveyResultsCsvUrl } from "./browser-client";
import {
  AddedAlternative,
  AddedQuestion,
  ChangedAlternative,
  ChangedCompletionText,
  ChangedQuestionHelp,
  ChangedQuestionKind,
  ChangedQuestionLabel,
  ChangedQuestionRequired,
  ChangedTitle,
  DismissedBanner,
  RemovedAlternative,
  RemovedQuestion,
  RequestedResults,
  RetriedCatalog,
  RetriedList,
  RetriedResults,
  SelectedDepartment,
  SelectedResultsVisibility,
  SelectedSemester,
  SelectedSurvey,
  SubmittedClose,
  SubmittedCreate,
  type Message,
} from "./message";
import type { Model, QuestionDraft } from "./model";

const dateTimeFormatter = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
});

const dateFormatter = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const formatInstant = (value: string | null): string => {
  if (value === null) return "Ikke registrert";
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? dateTimeFormatter.format(instant) : value;
};

const semesterLabel = (semester: { readonly startAt: string; readonly endAt: string }): string => {
  const start = new Date(semester.startAt);
  const end = new Date(semester.endAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return `${semester.startAt} – ${semester.endAt}`;
  }
  return `${dateFormatter.format(start)} – ${dateFormatter.format(end)}`;
};

const stateLabel = (state: "Open" | "Closed") => (state === "Open" ? "Åpen" : "Lukket");

const visibilityLabel = (visibility: "DepartmentManagers" | "GlobalAdministrators") =>
  visibility === "DepartmentManagers"
    ? "Avdelingsledere og globale administratorer"
    : "Bare globale administratorer";

const banner = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.banner !== null) {
    return h.section(
      [h.Class("school-surveys__banner school-surveys__banner--error"), h.Role("alert")],
      [
        h.h2([], [model.banner._tag === "Denied" ? "Ingen tilgang" : "Kunne ikke fullføre"]),
        h.p([], [model.banner.message]),
        h.button(
          [h.Type("button"), h.Class("school-surveys__dismiss"), h.OnClick(DismissedBanner())],
          ["Lukk melding"],
        ),
      ],
    );
  }
  if (model.successMessage === null) return h.empty;
  return h.section(
    [h.Class("school-surveys__banner school-surveys__banner--success"), h.Role("status")],
    [
      h.h2([], ["Endringen er lagret"]),
      h.p([], [model.successMessage]),
      h.button(
        [h.Type("button"), h.Class("school-surveys__dismiss"), h.OnClick(DismissedBanner())],
        ["Lukk melding"],
      ),
    ],
  );
};

const questionEditor = (
  question: QuestionDraft,
  disabled: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const prefix = `school-survey-question-${question.draftId}`;
  const supportsAlternatives = question.kind !== "Text";
  return h.fieldset(
    [h.Class("school-surveys__question"), h.AriaBusy(disabled)],
    [
      h.legend([], [`Spørsmål ${question.draftId}`]),
      h.div(
        [h.Class("school-surveys__question-actions")],
        [
          h.button(
            [
              h.Type("button"),
              h.Class("school-surveys__remove"),
              h.Disabled(disabled),
              h.OnClick(RemovedQuestion({ draftId: question.draftId })),
            ],
            ["Fjern spørsmål"],
          ),
        ],
      ),
      h.div(
        [h.Class("school-surveys__field")],
        [
          h.label([h.For(`${prefix}-kind`)], ["Spørsmålstype"]),
          h.select(
            [
              h.Id(`${prefix}-kind`),
              h.Value(question.kind),
              h.Disabled(disabled),
              h.OnChange((value) =>
                ChangedQuestionKind({
                  draftId: question.draftId,
                  kind: value === "List" || value === "Radio" || value === "Check" ? value : "Text",
                }),
              ),
            ],
            [
              h.option([h.Value("Text")], ["Tekst"]),
              h.option([h.Value("List")], ["Liste"]),
              h.option([h.Value("Radio")], ["Ett valg"]),
              h.option([h.Value("Check")], ["Flere valg"]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("school-surveys__field")],
        [
          h.label([h.For(`${prefix}-label`)], ["Spørsmål"]),
          h.textarea([
            h.Id(`${prefix}-label`),
            h.Value(question.label),
            h.Disabled(disabled),
            h.Attribute("required", ""),
            h.OnInput((value) => ChangedQuestionLabel({ draftId: question.draftId, value })),
          ]),
        ],
      ),
      h.div(
        [h.Class("school-surveys__field")],
        [
          h.label([h.For(`${prefix}-help`)], ["Hjelpetekst (valgfritt)"]),
          h.textarea([
            h.Id(`${prefix}-help`),
            h.Value(question.help),
            h.Disabled(disabled),
            h.OnInput((value) => ChangedQuestionHelp({ draftId: question.draftId, value })),
          ]),
        ],
      ),
      h.div(
        [h.Class("school-surveys__check")],
        [
          h.input([
            h.Id(`${prefix}-required`),
            h.Type("checkbox"),
            h.Checked(question.required),
            h.Disabled(disabled),
            h.OnChange((value) =>
              ChangedQuestionRequired({ draftId: question.draftId, required: value === "on" }),
            ),
          ]),
          h.label([h.For(`${prefix}-required`)], ["Svar er påkrevd"]),
        ],
      ),
      supportsAlternatives
        ? h.div(
            [h.Class("school-surveys__alternatives"), h.AriaLabel("Svaralternativer")],
            [
              h.h3([], ["Svaralternativer"]),
              ...question.alternatives.map((alternative, index) =>
                h.div(
                  [h.Class("school-surveys__alternative")],
                  [
                    h.label(
                      [
                        h.Class("school-surveys__visually-hidden"),
                        h.For(`${prefix}-alternative-${index}`),
                      ],
                      [`Alternativ ${index + 1}`],
                    ),
                    h.input([
                      h.Id(`${prefix}-alternative-${index}`),
                      h.Type("text"),
                      h.Value(alternative),
                      h.Disabled(disabled),
                      h.Attribute("required", ""),
                      h.OnInput((value) =>
                        ChangedAlternative({ draftId: question.draftId, index, value }),
                      ),
                    ]),
                    h.button(
                      [
                        h.Type("button"),
                        h.Class("school-surveys__remove"),
                        h.Disabled(disabled),
                        h.OnClick(RemovedAlternative({ draftId: question.draftId, index })),
                      ],
                      ["Fjern alternativ"],
                    ),
                  ],
                ),
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class("school-surveys__secondary"),
                  h.Disabled(disabled),
                  h.OnClick(AddedAlternative({ draftId: question.draftId })),
                ],
                ["Legg til alternativ"],
              ),
            ],
          )
        : h.empty,
    ],
  );
};

const createForm = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.catalog._tag !== "Success") return h.empty;
  const catalog = model.catalog.data;
  const disabled = model.pendingCommand !== null;
  return h.form(
    [
      h.Class("school-surveys__form"),
      h.OnSubmit(SubmittedCreate()),
      h.AriaBusy(disabled),
      h.Attribute("novalidate", ""),
    ],
    [
      h.h2([], ["Opprett skoleundersøkelse"]),
      h.p(
        [h.Class("school-surveys__hint")],
        ["Undersøkelsen åpnes med én gang og kan ikke redigeres etter opprettelse."],
      ),
      h.div(
        [h.Class("school-surveys__field")],
        [
          h.label([h.For("school-surveys-department")], ["Avdeling"]),
          h.select(
            [
              h.Id("school-surveys-department"),
              h.Value(model.draft.departmentId ?? ""),
              h.Disabled(disabled),
              h.OnChange((value) =>
                SelectedDepartment({
                  departmentId: value === "" ? null : (value as never),
                }),
              ),
            ],
            [
              h.option([h.Value("")], ["Velg avdeling"]),
              ...catalog.departments.map((department) =>
                h.option([h.Value(department.departmentId)], [department.name]),
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("school-surveys__field")],
        [
          h.label([h.For("school-surveys-semester")], ["Semester"]),
          h.select(
            [
              h.Id("school-surveys-semester"),
              h.Value(model.draft.semesterId ?? ""),
              h.Disabled(disabled),
              h.OnChange((value) =>
                SelectedSemester({ semesterId: value === "" ? null : (value as never) }),
              ),
            ],
            [
              h.option([h.Value("")], ["Velg semester"]),
              ...catalog.semesters.map((semester) =>
                h.option([h.Value(semester.semesterId)], [semesterLabel(semester)]),
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("school-surveys__field")],
        [
          h.label([h.For("school-surveys-title")], ["Tittel"]),
          h.input([
            h.Id("school-surveys-title"),
            h.Type("text"),
            h.Value(model.draft.title),
            h.Disabled(disabled),
            h.Attribute("required", ""),
            h.OnInput((value) => ChangedTitle({ value })),
          ]),
        ],
      ),
      h.div(
        [h.Class("school-surveys__field school-surveys__field--wide")],
        [
          h.label([h.For("school-surveys-completion")], ["Tekst etter innsending"]),
          h.textarea([
            h.Id("school-surveys-completion"),
            h.Value(model.draft.completionText),
            h.Disabled(disabled),
            h.Attribute("required", ""),
            h.OnInput((value) => ChangedCompletionText({ value })),
          ]),
        ],
      ),
      h.div(
        [h.Class("school-surveys__field")],
        [
          h.label([h.For("school-surveys-results-visibility")], ["Hvem kan se resultatene?"]),
          h.select(
            [
              h.Id("school-surveys-results-visibility"),
              h.Value(model.draft.resultsVisibility),
              h.Disabled(disabled),
              h.OnChange((value) =>
                SelectedResultsVisibility({
                  resultsVisibility:
                    value === "GlobalAdministrators"
                      ? "GlobalAdministrators"
                      : "DepartmentManagers",
                }),
              ),
            ],
            [
              h.option(
                [h.Value("DepartmentManagers")],
                ["Avdelingsledere og globale administratorer"],
              ),
              h.option([h.Value("GlobalAdministrators")], ["Bare globale administratorer"]),
            ],
          ),
        ],
      ),
      h.section(
        [h.Class("school-surveys__questions"), h.AriaLabelledBy("school-surveys-questions-title")],
        [
          h.h2([h.Id("school-surveys-questions-title")], ["Spørsmål"]),
          h.p(
            [h.Class("school-surveys__hint")],
            ["Rekkefølgen her blir rekkefølgen i skjemaet og CSV-filen."],
          ),
          ...model.draft.questions.map((question) => questionEditor(question, disabled, h)),
          h.div(
            [h.Class("school-surveys__question-kinds"), h.AriaLabel("Legg til spørsmål")],
            [
              h.button(
                [
                  h.Type("button"),
                  h.Class("school-surveys__secondary"),
                  h.Disabled(disabled),
                  h.OnClick(AddedQuestion({ kind: "Text" })),
                ],
                ["Legg til tekstspørsmål"],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class("school-surveys__secondary"),
                  h.Disabled(disabled),
                  h.OnClick(AddedQuestion({ kind: "List" })),
                ],
                ["Legg til listespørsmål"],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class("school-surveys__secondary"),
                  h.Disabled(disabled),
                  h.OnClick(AddedQuestion({ kind: "Radio" })),
                ],
                ["Legg til ettvalgs-spørsmål"],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class("school-surveys__secondary"),
                  h.Disabled(disabled),
                  h.OnClick(AddedQuestion({ kind: "Check" })),
                ],
                ["Legg til flervalgsspørsmål"],
              ),
            ],
          ),
        ],
      ),
      h.button(
        [
          h.Type("submit"),
          h.Class("school-surveys__submit"),
          h.Disabled(
            disabled ||
              model.draft.departmentId === null ||
              model.draft.semesterId === null ||
              model.draft.questions.length === 0,
          ),
        ],
        [disabled ? "Oppretter undersøkelse …" : "Opprett undersøkelse"],
      ),
    ],
  );
};

const listView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.list._tag === "Idle") {
    return h.section(
      [h.Class("school-surveys__empty"), h.Role("status")],
      [h.h2([], ["Velg avdeling og semester"]), h.p([], ["Velg et scope for å se undersøkelser."])],
    );
  }
  if (model.list._tag === "Loading") {
    return h.section(
      [h.Class("school-surveys__loading"), h.Role("status"), h.AriaLive("polite")],
      ["Henter undersøkelser …"],
    );
  }
  if (model.list._tag === "Failure") {
    return h.section(
      [h.Class("school-surveys__error"), h.Role("alert")],
      [
        h.h2([], ["Kunne ikke hente undersøkelser"]),
        h.p([], [model.list.error.message]),
        h.button(
          [h.Type("button"), h.Class("school-surveys__secondary"), h.OnClick(RetriedList())],
          ["Last oversikten på nytt"],
        ),
      ],
    );
  }
  const surveys = model.list.data.surveys;
  if (surveys.length === 0) {
    return h.section(
      [h.Class("school-surveys__empty"), h.Role("status")],
      [
        h.h2([], ["Ingen undersøkelser"]),
        h.p([], ["Det finnes ingen skoleundersøkelser for den valgte avdelingen og semesteret."]),
      ],
    );
  }
  return h.section(
    [h.Class("school-surveys__results"), h.AriaLabelledBy("school-surveys-list-title")],
    [
      h.div(
        [h.Class("school-surveys__results-heading")],
        [
          h.h2([h.Id("school-surveys-list-title")], ["Undersøkelser"]),
          h.p([], [surveys.length === 1 ? "1 undersøkelse" : `${surveys.length} undersøkelser`]),
        ],
      ),
      h.div(
        [
          h.Class("school-surveys__table-scroll"),
          h.Tabindex(0),
          h.AriaLabel("Undersøkelsesoversikt, bla sidelengs ved behov"),
        ],
        [
          h.table(
            [h.Class("school-surveys__table")],
            [
              h.caption([h.Class("school-surveys__visually-hidden")], ["Skoleundersøkelser"]),
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    [
                      h.th([h.Scope("col")], ["Tittel"]),
                      h.th([h.Scope("col")], ["Status"]),
                      h.th([h.Scope("col")], ["Svar"]),
                      h.th([h.Scope("col")], ["Resultatpolicy"]),
                      h.th([h.Scope("col")], ["Handling"]),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                surveys.map((survey) =>
                  h.tr(
                    [h.DataAttribute("survey-id", survey.surveyId)],
                    [
                      h.th([h.Scope("row")], [survey.title]),
                      h.td([], [stateLabel(survey.state)]),
                      h.td([], [String(survey.responseCount)]),
                      h.td([], [visibilityLabel(survey.resultsVisibility)]),
                      h.td(
                        [],
                        [
                          h.button(
                            [
                              h.Type("button"),
                              h.Class("school-surveys__secondary"),
                              h.Disabled(model.pendingCommand !== null),
                              h.OnClick(SelectedSurvey({ surveyId: survey.surveyId })),
                            ],
                            ["Åpne"],
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const definitionView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const survey = model.detail;
  if (survey === null) return h.empty;
  const disabled = model.pendingCommand !== null;
  return h.section(
    [h.Class("school-surveys__detail"), h.AriaLabelledBy("school-surveys-detail-title")],
    [
      h.div(
        [h.Class("school-surveys__detail-heading")],
        [
          h.div(
            [],
            [
              h.h2([h.Id("school-surveys-detail-title")], [survey.title]),
              h.p(
                [],
                [
                  `${stateLabel(survey.state)} · revisjon ${survey.revision} · ${survey.responseCount} svar`,
                ],
              ),
            ],
          ),
          h.span(
            [h.Class(`school-surveys__state school-surveys__state--${survey.state.toLowerCase()}`)],
            [stateLabel(survey.state)],
          ),
        ],
      ),
      h.dl(
        [h.Class("school-surveys__metadata")],
        [
          h.div([], [h.dt([], ["Semester"]), h.dd([], [survey.semesterLabel])]),
          h.div(
            [],
            [h.dt([], ["Resultatpolicy"]), h.dd([], [visibilityLabel(survey.resultsVisibility)])],
          ),
          h.div([], [h.dt([], ["Opprettet"]), h.dd([], [formatInstant(survey.createdAt)])]),
          h.div([], [h.dt([], ["Lukket"]), h.dd([], [formatInstant(survey.closedAt)])]),
        ],
      ),
      h.div(
        [h.Class("school-surveys__links")],
        [
          h.a(
            [
              h.Href(schoolSurveyPath(survey.surveyId)),
              h.Target("_blank"),
              h.Rel("noopener noreferrer"),
              h.Class("school-surveys__secondary"),
            ],
            ["Åpne offentlig skjema"],
          ),
          h.a(
            [
              h.Href(schoolSurveyResultsCsvUrl(survey.surveyId)),
              h.Download(""),
              h.Class("school-surveys__secondary"),
            ],
            ["Last ned CSV"],
          ),
          h.button(
            [
              h.Type("button"),
              h.Class("school-surveys__secondary"),
              h.Disabled(disabled),
              h.OnClick(RequestedResults({ surveyId: survey.surveyId })),
            ],
            ["Vis resultater"],
          ),
          survey.state === "Open"
            ? h.button(
                [
                  h.Type("button"),
                  h.Class("school-surveys__danger"),
                  h.Disabled(disabled),
                  h.OnClick(
                    SubmittedClose({
                      surveyId: survey.surveyId,
                      expectedRevision: survey.revision,
                    }),
                  ),
                ],
                [disabled ? "Lukker undersøkelse …" : "Lukk undersøkelse"],
              )
            : h.empty,
        ],
      ),
      h.section(
        [
          h.Class("school-surveys__definition"),
          h.AriaLabelledBy("school-surveys-definition-title"),
        ],
        [
          h.h3([h.Id("school-surveys-definition-title")], ["Spørsmål i rekkefølge"]),
          h.ol(
            [],
            survey.questions.map((question) =>
              h.li(
                [],
                [
                  h.strong([], [question.label]),
                  ` (${question.kind}${question.required ? ", påkrevd" : ", valgfritt"})`,
                  question.help === null ? h.empty : h.p([], [question.help]),
                  question.kind === "Text" ? h.empty : h.p([], [question.alternatives.join(" · ")]),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );
};

const resultsView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.results._tag === "Idle") return h.empty;
  if (model.results._tag === "Loading") {
    return h.section(
      [h.Class("school-surveys__loading"), h.Role("status"), h.AriaLive("polite")],
      ["Henter resultater …"],
    );
  }
  if (model.results._tag === "Failure") {
    return h.section(
      [h.Class("school-surveys__error"), h.Role("alert")],
      [
        h.h2([], ["Kunne ikke hente resultater"]),
        h.p([], [model.results.error.message]),
        h.button(
          [h.Type("button"), h.Class("school-surveys__secondary"), h.OnClick(RetriedResults())],
          ["Prøv på nytt"],
        ),
      ],
    );
  }
  const { results } = model;
  const questions = results.data.survey.questions;
  if (results.data.responses.length === 0) {
    return h.section(
      [h.Class("school-surveys__empty"), h.Role("status")],
      [
        h.h2([], ["Ingen svar ennå"]),
        h.p([], ["Resultatene oppdateres når en skole sender inn skjemaet."]),
      ],
    );
  }
  return h.section(
    [
      h.Class("school-surveys__results school-surveys__response-results"),
      h.AriaLabelledBy("school-surveys-results-title"),
    ],
    [
      h.div(
        [h.Class("school-surveys__results-heading")],
        [
          h.h2([h.Id("school-surveys-results-title")], ["Anonyme svar"]),
          h.p(
            [],
            [
              results.data.responseCount === 1
                ? "1 anonymt svar. Svarene vises i spørsmålrekkefølge."
                : `${results.data.responseCount} anonyme svar. Svarene vises i spørsmålrekkefølge.`,
            ],
          ),
        ],
      ),
      h.div(
        [
          h.Class("school-surveys__table-scroll"),
          h.Tabindex(0),
          h.AriaLabel("Resultattabell, bla sidelengs ved behov"),
        ],
        [
          h.table(
            [h.Class("school-surveys__table school-surveys__answers-table")],
            [
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    [
                      h.th([h.Scope("col")], ["Innsendt"]),
                      h.th([h.Scope("col")], ["Skole"]),
                      ...questions.map((question) => h.th([h.Scope("col")], [question.label])),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                results.data.responses.map((response) =>
                  h.tr(
                    [],
                    [
                      h.td(
                        [],
                        [
                          h.time(
                            [h.Datetime(response.submittedAt)],
                            [formatInstant(response.submittedAt)],
                          ),
                        ],
                      ),
                      h.th([h.Scope("row")], [response.school.name]),
                      ...questions.map((question) => {
                        const answer = response.answers.find(
                          (candidate) => candidate.questionId === question.questionId,
                        );
                        const value =
                          answer === undefined
                            ? "Ikke besvart"
                            : answer.kind === "Check"
                              ? answer.values.length === 0
                                ? "Ikke besvart"
                                : answer.values.join(" · ")
                              : (answer.value ?? "Ikke besvart");
                        return h.td([], [value]);
                      }),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const catalogState = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.catalog._tag === "Loading" || model.catalog._tag === "Idle") {
    return h.section(
      [h.Class("school-surveys__loading"), h.Role("status"), h.AriaLive("polite")],
      ["Henter tilgjengelige avdelinger og semestre …"],
    );
  }
  if (model.catalog._tag === "Failure") {
    return h.section(
      [h.Class("school-surveys__error"), h.Role("alert")],
      [
        h.h2(
          [],
          [
            model.catalog.error._tag === "Denied"
              ? "Ingen tilgang"
              : "Kunne ikke starte undersøkelsesadministrasjonen",
          ],
        ),
        h.p([], [model.catalog.error.message]),
        h.button(
          [h.Type("button"), h.Class("school-surveys__secondary"), h.OnClick(RetriedCatalog())],
          ["Prøv på nytt"],
        ),
      ],
    );
  }
  return h.div(
    [h.Class("school-surveys__workspace")],
    [
      banner(model, h),
      createForm(model, h),
      listView(model, h),
      definitionView(model, h),
      resultsView(model, h),
    ],
  );
};

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("school-surveys"), h.AriaLabelledBy("school-surveys-page-title")],
    [
      h.header(
        [h.Class("school-surveys__header")],
        [
          h.p([h.Class("school-surveys__eyebrow")], ["Skoler"]),
          h.h1([h.Id("school-surveys-page-title")], ["Undersøkelser"]),
          h.p(
            [],
            ["Opprett, følg opp og avslutt anonyme skoleundersøkelser innenfor avdelingen din."],
          ),
        ],
      ),
      catalogState(model, h),
    ],
  );
