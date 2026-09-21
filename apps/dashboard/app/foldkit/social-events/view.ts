import { IdempotencyKey } from "@vektorprogrammet/http-api";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  ChangedDescription,
  ChangedEndAt,
  ChangedLink,
  ChangedStartAt,
  ChangedTitle,
  DismissedFailure,
  RetriedList,
  RetriedScope,
  SelectedAudience,
  SelectedDepartment,
  SelectedSemester,
  SubmittedCreate,
  type Message,
} from "./message";
import type { Model } from "./model";

const dateTimeFormatter = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
});

const dateFormatter = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "medium",
  timeZone: "UTC",
});

export const audienceLabel = (audience: "TeamMembers" | "AssistantsAndTeamMembers"): string =>
  audience === "TeamMembers" ? "Kun teammedlemmer" : "Teammedlemmer og assistenter";

export const timeLabel = (startAt: string, observedAt: string): string | null => {
  const start = new Date(startAt).getTime();
  const observed = new Date(observedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(observed)) return null;
  if (start < observed) return "Har vært";
  return start < observed + 7 * 24 * 60 * 60 * 1000 ? "Skjer innen en uke" : null;
};

const formatInstant = (instant: string): string => {
  const value = new Date(instant);
  return Number.isFinite(value.getTime()) ? dateTimeFormatter.format(value) : instant;
};

const semesterLabel = (semester: { readonly startAt: string; readonly endAt: string }): string => {
  const start = new Date(semester.startAt);
  const end = new Date(semester.endAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return `${semester.startAt} – ${semester.endAt}`;
  }
  return `${dateFormatter.format(start)} – ${dateFormatter.format(end)}`;
};

const failureBanner = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.failure === null) return h.empty;
  return h.section(
    [h.Class("social-events__banner social-events__banner--error"), h.Role("alert")],
    [
      h.h2([], ["Kunne ikke lagre arrangementet"]),
      h.p([], [model.failure.message]),
      h.button(
        [h.Type("button"), h.Class("social-events__dismiss"), h.OnClick(DismissedFailure())],
        ["Lukk melding"],
      ),
    ],
  );
};

const successBanner = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.success
    ? h.section(
        [h.Class("social-events__banner social-events__banner--success"), h.Role("status")],
        [
          h.h2([], ["Arrangementet er lagret"]),
          h.p(
            [],
            [
              model.list._tag === "Loading"
                ? "Den oppdaterte arrangementlisten hentes nå."
                : "Arrangementlisten er oppdatert fra serveren.",
            ],
          ),
        ],
      )
    : h.empty;

const scopeFailure = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.scope._tag === "Failure"
    ? h.section(
        [h.Class("social-events__error"), h.Role("alert")],
        [
          h.h2(
            [],
            [model.scope.error._tag === "Denied" ? "Ingen tilgang" : "Kunne ikke hente scope"],
          ),
          h.p([], [model.scope.error.message]),
          h.button(
            [h.Type("button"), h.Class("social-events__retry"), h.OnClick(RetriedScope())],
            ["Prøv igjen"],
          ),
        ],
      )
    : h.empty;

const listView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.list._tag === "Idle") {
    return h.section(
      [h.Class("social-events__empty"), h.Role("status")],
      [h.h2([], ["Velg avdeling og semester"]), h.p([], ["Velg et scope for å se arrangementer."])],
    );
  }
  if (model.list._tag === "Loading") {
    return h.section(
      [h.Class("social-events__loading"), h.Role("status"), h.AriaLive("polite")],
      ["Henter arrangementer …"],
    );
  }
  if (model.list._tag === "Failure") {
    return h.section(
      [h.Class("social-events__error"), h.Role("alert")],
      [
        h.h2([], [model.success ? "Arrangementet er lagret" : "Kunne ikke hente arrangementer"]),
        h.p(
          [],
          [
            model.success
              ? "Arrangementet ble lagret, men den oppdaterte listen kunne ikke hentes."
              : model.list.error.message,
          ],
        ),
        h.button(
          [h.Type("button"), h.Class("social-events__retry"), h.OnClick(RetriedList())],
          ["Last listen på nytt"],
        ),
      ],
    );
  }

  const list = model.list.data;
  const scope = model.scope._tag === "Success" ? model.scope.data : null;
  const department =
    scope?.departments.find((candidate) => candidate.departmentId === list.departmentId) ?? null;
  const semester =
    scope?.semesters.find((candidate) => candidate.semesterId === list.semesterId) ?? null;
  const events = list.events;
  if (events.length === 0) {
    return h.section(
      [h.Class("social-events__empty"), h.Role("status")],
      [
        h.h2([], ["Ingen arrangementer"]),
        h.p([], ["Det finnes ingen arrangementer for den valgte avdelingen og semesteret."]),
      ],
    );
  }

  return h.section(
    [h.Class("social-events__results"), h.AriaLabelledBy("social-events-list-title")],
    [
      h.div(
        [h.Class("social-events__results-heading")],
        [
          h.h2([h.Id("social-events-list-title")], ["Lagrede arrangementer"]),
          h.p(
            [],
            [
              `Avdeling: ${department?.name ?? "Ukjent avdeling"}. Semester: ${
                semester === null ? "Ukjent semester" : semesterLabel(semester)
              }.`,
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("social-events__table-scroll"), h.Attribute("tabindex", "0")],
        [
          h.table(
            [h.Class("social-events__table")],
            [
              h.thead(
                [],
                [
                  h.tr(
                    [],
                    [
                      h.th([h.Attribute("scope", "col")], ["Tittel"]),
                      h.th([h.Attribute("scope", "col")], ["Beskrivelse"]),
                      h.th([h.Attribute("scope", "col")], ["Lenke"]),
                      h.th([h.Attribute("scope", "col")], ["Start"]),
                      h.th([h.Attribute("scope", "col")], ["Slutt"]),
                      h.th([h.Attribute("scope", "col")], ["Status"]),
                      h.th([h.Attribute("scope", "col")], ["Målgruppe"]),
                      h.th([h.Attribute("scope", "col")], ["Avdeling"]),
                      h.th([h.Attribute("scope", "col")], ["Semester"]),
                    ],
                  ),
                ],
              ),
              h.tbody(
                [],
                events.map((event) => {
                  const label = timeLabel(event.startAt, list.observedAt);
                  const eventDepartment =
                    scope?.departments.find(
                      (candidate) => candidate.departmentId === event.departmentId,
                    ) ?? null;
                  const eventSemester =
                    scope?.semesters.find(
                      (candidate) => candidate.semesterId === event.semesterId,
                    ) ?? null;
                  return h.tr(
                    [h.DataAttribute("event-id", String(event.eventId))],
                    [
                      h.th([h.Attribute("scope", "row")], [event.title]),
                      h.td(
                        [
                          h.DataAttribute(
                            "empty-description",
                            String(event.description.length === 0),
                          ),
                        ],
                        [event.description.length === 0 ? "Ingen beskrivelse" : event.description],
                      ),
                      h.td(
                        [h.DataAttribute("null-link", String(event.link === null))],
                        [event.link ?? "Ingen lenke"],
                      ),
                      h.td(
                        [],
                        [h.time([h.Datetime(event.startAt)], [formatInstant(event.startAt)])],
                      ),
                      h.td([], [h.time([h.Datetime(event.endAt)], [formatInstant(event.endAt)])]),
                      h.td(
                        [],
                        [
                          label === null
                            ? h.empty
                            : h.span([h.Class("social-events__label")], [label]),
                        ],
                      ),
                      h.td([], [audienceLabel(event.audience)]),
                      h.td([], [eventDepartment?.name ?? "Ukjent avdeling"]),
                      h.td(
                        [],
                        [eventSemester === null ? "Ukjent semester" : semesterLabel(eventSemester)],
                      ),
                    ],
                  );
                }),
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const workspace = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.scope._tag === "Loading" || model.scope._tag === "Idle") {
    return h.section(
      [h.Class("social-events__loading"), h.Role("status"), h.AriaLive("polite")],
      ["Henter tilgjengelige avdelinger og semestre …"],
    );
  }
  if (model.scope._tag === "Failure") return scopeFailure(model, h);

  const scope = model.scope.data;
  const disabled = model.pendingCommand !== null;
  const commandId = IdempotencyKey.make(
    `socialevents-${model.commandSeed}-${model.commandSequence}`,
  );
  const listPending = model.list._tag === "Idle" || model.list._tag === "Loading";
  return h.div(
    [h.Class("social-events__ready")],
    [
      failureBanner(model, h),
      successBanner(model, h),
      h.form(
        [
          h.Class("social-events__form"),
          h.OnSubmit(SubmittedCreate({ commandId })),
          h.AriaBusy(disabled),
          h.Attribute("novalidate", ""),
        ],
        [
          h.h2([], ["Opprett arrangement"]),
          h.div(
            [h.Class("social-events__field")],
            [
              h.label([h.For("social-events-department")], ["Avdeling"]),
              h.select(
                [
                  h.Id("social-events-department"),
                  h.Value(model.draft.departmentId ?? ""),
                  h.Disabled(disabled),
                  h.OnChange((value) =>
                    SelectedDepartment({ departmentId: value === "" ? null : (value as never) }),
                  ),
                ],
                [
                  h.option([h.Value("")], ["Velg avdeling"]),
                  ...scope.departments.map((department) =>
                    h.option([h.Value(department.departmentId)], [department.name]),
                  ),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class("social-events__field")],
            [
              h.label([h.For("social-events-semester")], ["Semester"]),
              h.select(
                [
                  h.Id("social-events-semester"),
                  h.Value(model.draft.semesterId ?? ""),
                  h.Disabled(disabled),
                  h.OnChange((value) =>
                    SelectedSemester({ semesterId: value === "" ? null : (value as never) }),
                  ),
                ],
                [
                  h.option([h.Value("")], ["Velg semester"]),
                  ...scope.semesters.map((semester) =>
                    h.option([h.Value(semester.semesterId)], [semesterLabel(semester)]),
                  ),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class("social-events__field")],
            [
              h.label([h.For("social-events-audience")], ["Målgruppe"]),
              h.select(
                [
                  h.Id("social-events-audience"),
                  h.Value(model.draft.audience),
                  h.Disabled(disabled),
                  h.OnChange((value) =>
                    SelectedAudience({
                      audience:
                        value === "TeamMembers" ? "TeamMembers" : "AssistantsAndTeamMembers",
                    }),
                  ),
                ],
                [
                  h.option([h.Value("TeamMembers")], ["Kun teammedlemmer"]),
                  h.option([h.Value("AssistantsAndTeamMembers")], ["Teammedlemmer og assistenter"]),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class("social-events__field")],
            [
              h.label([h.For("social-events-title")], ["Tittel"]),
              h.input([
                h.Id("social-events-title"),
                h.Type("text"),
                h.Value(model.draft.title),
                h.Disabled(disabled),
                h.OnInput((value) => ChangedTitle({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class("social-events__field")],
            [
              h.label([h.For("social-events-description")], ["Beskrivelse"]),
              h.textarea([
                h.Id("social-events-description"),
                h.Value(model.draft.description),
                h.Disabled(disabled),
                h.OnInput((value) => ChangedDescription({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class("social-events__field")],
            [
              h.label([h.For("social-events-link")], ["Lenke til arrangementet (valgfritt)"]),
              h.input([
                h.Id("social-events-link"),
                h.Type("url"),
                h.Value(model.draft.link),
                h.Disabled(disabled),
                h.OnInput((value) => ChangedLink({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class("social-events__field")],
            [
              h.label([h.For("social-events-start")], ["Starttid"]),
              h.input([
                h.Id("social-events-start"),
                h.Type("datetime-local"),
                h.Value(model.draft.startAt),
                h.Disabled(disabled),
                h.OnInput((value) => ChangedStartAt({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class("social-events__field")],
            [
              h.label([h.For("social-events-end")], ["Sluttid"]),
              h.input([
                h.Id("social-events-end"),
                h.Type("datetime-local"),
                h.Value(model.draft.endAt),
                h.Disabled(disabled),
                h.OnInput((value) => ChangedEndAt({ value })),
              ]),
            ],
          ),
          h.p(
            [h.Class("social-events__hint")],
            ["Tidspunktene tolkes som lokal tid og lagres som UTC."],
          ),
          h.button(
            [
              h.Type("submit"),
              h.Class("social-events__submit"),
              h.Disabled(
                disabled ||
                  listPending ||
                  model.draft.departmentId === null ||
                  model.draft.semesterId === null,
              ),
            ],
            [disabled ? "Lagrer arrangement …" : "Lagre arrangement"],
          ),
        ],
      ),
      listView(model, h),
    ],
  );
};

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("social-events"), h.AriaLabelledBy("social-events-page-title")],
    [
      h.header(
        [h.Class("social-events__header")],
        [
          h.p([h.Class("social-events__eyebrow")], ["Team"]),
          h.h1([h.Id("social-events-page-title")], ["Arrangementer"]),
          h.p([], ["Opprett og se arrangementer for avdelingene du har tilgang til."]),
        ],
      ),
      workspace(model, h),
    ],
  );
