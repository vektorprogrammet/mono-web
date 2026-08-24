import { Button } from "@foldkit/ui";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { RetriedCatalog, type Message } from "./message";
import type {
  FieldOfStudyCatalogSnapshot,
  Model,
  OrganizationCatalogSnapshot,
  TeamCatalogSnapshot,
} from "./model";

const retryButton = (h: HtmlBuilder<Message>): Html =>
  Button.view(
    {
      type: "button",
      onClick: RetriedCatalog(),
      isDisabled: false,
      toView: ({ button }) =>
        h.button([...button, h.Class("organization-catalog__retry")], ["Prøv på nytt"]),
    },
    h,
  );

const departmentNames = (
  snapshot: OrganizationCatalogSnapshot,
): ReadonlyMap<string, string> =>
  new Map(snapshot.departments.map((department) => [department.departmentId, department.name]));

const teamTable = (snapshot: TeamCatalogSnapshot, h: HtmlBuilder<Message>): Html => {
  const namesByDepartment = departmentNames(snapshot);
  return h.div(
    [
      h.Class("organization-catalog__table-scroll"),
      h.Tabindex(0),
      h.AriaLabel("Teamoversikt, bla sidelengs ved behov"),
    ],
    [
      h.table(
        [h.Class("organization-catalog__table")],
        [
          h.caption([h.Class("organization-catalog__visually-hidden")], [
            "Aktive og inaktive team i organisasjonen",
          ]),
          h.thead(
            [],
            [
              h.tr(
                [],
                ["Navn", "Avdeling", "E-post", "Beskrivelse", "Søknader", "Status"].map(
                  (label) => h.th([h.Scope("col")], [label]),
                ),
              ),
            ],
          ),
          h.tbody(
            [],
            snapshot.records.map((team) =>
              h.tr([h.DataAttribute("organization-id", team.teamId)], [
                h.th([h.Scope("row")], [team.name]),
                h.td([], [namesByDepartment.get(team.departmentId) ?? team.departmentId]),
                h.td([], [
                  team.email === null
                    ? "Ikke oppgitt"
                    : h.a([h.Href(`mailto:${team.email}`)], [team.email]),
                ]),
                h.td([], [team.shortDescription ?? team.description ?? "Ikke oppgitt"]),
                h.td([], [team.acceptApplication ? "Åpne" : "Stengt"]),
                h.td([], [team.active ? "Aktiv" : "Inaktiv"]),
              ]),
            ),
          ),
        ],
      ),
    ],
  );
};

const fieldOfStudyTable = (
  snapshot: FieldOfStudyCatalogSnapshot,
  h: HtmlBuilder<Message>,
): Html => {
  const namesByDepartment = departmentNames(snapshot);
  return h.div(
    [
      h.Class("organization-catalog__table-scroll"),
      h.Tabindex(0),
      h.AriaLabel("Studieretningsoversikt, bla sidelengs ved behov"),
    ],
    [
      h.table(
        [h.Class("organization-catalog__table")],
        [
          h.caption([h.Class("organization-catalog__visually-hidden")], [
            "Aktive og inaktive studieretninger i organisasjonen",
          ]),
          h.thead(
            [],
            [
              h.tr(
                [],
                ["Navn", "Kortnavn", "Avdeling", "Status"].map((label) =>
                  h.th([h.Scope("col")], [label]),
                ),
              ),
            ],
          ),
          h.tbody(
            [],
            snapshot.records.map((field) =>
              h.tr([h.DataAttribute("organization-id", field.fieldOfStudyId)], [
                h.th([h.Scope("row")], [field.name]),
                h.td([], [field.shortName]),
                h.td([], [
                  field.departmentId === null
                    ? "Felles for alle avdelinger"
                    : (namesByDepartment.get(field.departmentId) ?? field.departmentId),
                ]),
                h.td([], [field.active ? "Aktiv" : "Inaktiv"]),
              ]),
            ),
          ),
        ],
      ),
    ],
  );
};

const successfulCatalog = (
  snapshot: OrganizationCatalogSnapshot,
  h: HtmlBuilder<Message>,
): Html => {
  if (snapshot.records.length === 0) {
    return h.section(
      [h.Class("organization-catalog__empty"), h.AriaLabelledBy("organization-empty-title")],
      [
        h.h2([h.Id("organization-empty-title")], [
          snapshot._tag === "Team" ? "Ingen team er registrert" : "Ingen studieretninger er registrert",
        ]),
        h.p([], [
          snapshot._tag === "Team"
            ? "Nye team vises her når de er opprettet av en organisasjonsadministrator."
            : "Nye studieretninger vises her når de er opprettet av en organisasjonsadministrator.",
        ]),
      ],
    );
  }

  return h.section(
    [h.Class("organization-catalog__results"), h.AriaLabelledBy("organization-results-title")],
    [
      h.div([h.Class("organization-catalog__results-heading")], [
        h.h2([h.Id("organization-results-title")], [
          snapshot._tag === "Team" ? "Registrerte team" : "Registrerte studieretninger",
        ]),
        h.p([], [
          snapshot.records.length === 1
            ? "1 oppføring"
            : `${snapshot.records.length} oppføringer`,
        ]),
      ]),
      snapshot._tag === "Team" ? teamTable(snapshot, h) : fieldOfStudyTable(snapshot, h),
    ],
  );
};

const catalogState = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.match(model.catalog, {
    onIdle: () =>
      h.div(
        [h.Class("organization-catalog__loading"), h.Role("status"), h.AriaLive("polite")],
        ["Forbereder oversikten …"],
      ),
    onLoading: () =>
      h.div(
        [h.Class("organization-catalog__loading"), h.Role("status"), h.AriaLive("polite")],
        [
          h.span([h.Class("organization-catalog__spinner"), h.AriaHidden(true)], []),
          model.catalogKind === "Team" ? "Henter team …" : "Henter studieretninger …",
        ],
      ),
    onRefreshing: (snapshot) => successfulCatalog(snapshot, h),
    onFailure: (failure) =>
      h.section(
        [h.Class("organization-catalog__error"), h.Role("alert")],
        [
          h.h2([], [
            model.catalogKind === "Team"
              ? "Teamoversikten kunne ikke hentes"
              : "Studieretningene kunne ikke hentes",
          ]),
          h.p([], [failure]),
          retryButton(h),
        ],
      ),
    onStale: ({ data, error }) =>
      h.div([], [
        h.section(
          [h.Class("organization-catalog__error"), h.Role("alert")],
          [h.h2([], ["Oversikten kunne ikke oppdateres"]), h.p([], [error]), retryButton(h)],
        ),
        successfulCatalog(data, h),
      ]),
    onSuccess: (snapshot) => successfulCatalog(snapshot, h),
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("organization-catalog"), h.AriaLabelledBy("organization-catalog-title")],
    [
      h.header([h.Class("organization-catalog__header")], [
        h.p([h.Class("organization-catalog__eyebrow")], ["Organisasjon"]),
        h.h1([h.Id("organization-catalog-title")], [
          model.catalogKind === "Team" ? "Team" : "Studieretninger",
        ]),
        h.p([], [
          model.catalogKind === "Team"
            ? "Se teamene og avdelingene de tilhører."
            : "Se studieretningene som er tilgjengelige i organisasjonen.",
        ]),
      ]),
      catalogState(model, h),
    ],
  );
