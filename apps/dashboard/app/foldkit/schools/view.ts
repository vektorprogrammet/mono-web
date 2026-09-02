import { DepartmentId } from "@vektorprogrammet/domain/organization";
import type { SchoolDirectory, SchoolDirectoryEntry } from "@vektorprogrammet/domain/schools";
import { Input, Select } from "@foldkit/ui";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  GotDirectoryTabMessage,
  RetriedDirectory,
  SelectedDepartment,
  UpdatedSearch,
  type Message,
} from "./message";
import { SchoolDirectoryTabs, type Model, type SchoolDirectoryTab } from "./model";

const languageLabel = (language: SchoolDirectoryEntry["language"]): string =>
  language === "Norwegian" ? "Norsk" : "Internasjonal";

const matchesSearch = (school: SchoolDirectoryEntry, searchText: string): boolean => {
  const query = searchText.trim().toLocaleLowerCase("nb-NO");
  if (query.length === 0) return true;
  return [
    school.name,
    school.contactPerson,
    school.phone,
    school.email,
    languageLabel(school.language),
    ...school.departments.map((department) => department.name),
  ].some((value) => value.toLocaleLowerCase("nb-NO").includes(query));
};

const retryButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [h.Class("schools-directory__retry"), h.Type("button"), h.OnClick(RetriedDirectory())],
    ["Prøv igjen"],
  );

const schoolTable = (
  schools: ReadonlyArray<SchoolDirectoryEntry>,
  tab: SchoolDirectoryTab,
  searchText: string,
  h: HtmlBuilder<Message>,
): Html => {
  const visibleSchools = schools.filter((school) => matchesSearch(school, searchText));
  const statusLabel = tab === "Active" ? "aktive" : "inaktive";

  if (visibleSchools.length === 0) {
    return h.div(
      [h.Class("schools-directory__empty"), h.Role("status")],
      [
        h.h2([], [`Ingen ${statusLabel} skoler funnet`]),
        h.p(
          [],
          [
            searchText.trim().length === 0
              ? `Det er ingen ${statusLabel} skoler i den valgte avdelingen.`
              : "Ingen skoler samsvarer med søket.",
          ],
        ),
      ],
    );
  }

  return h.div(
    [
      h.Class("schools-directory__table-scroll"),
      h.Tabindex(0),
      h.Role("region"),
      h.AriaLabel(`${tab === "Active" ? "Aktive" : "Inaktive"} skoler`),
    ],
    [
      h.table(
        [h.Class("schools-directory__table")],
        [
          h.caption(
            [h.Class("schools-directory__visually-hidden")],
            [
              `${tab === "Active" ? "Aktive" : "Inaktive"} skoler med kontaktinformasjon, språk og avdelinger`,
            ],
          ),
          h.thead(
            [],
            [
              h.tr(
                [],
                ["Skole", "Kontaktperson", "Telefon", "E-post", "Språk", "Avdeling"].map((label) =>
                  h.th([h.Scope("col")], [label]),
                ),
              ),
            ],
          ),
          h.tbody(
            [],
            visibleSchools.map((school) =>
              h.tr(
                [h.DataAttribute("school-id", String(school.schoolId))],
                [
                  h.th([h.Scope("row")], [school.name]),
                  h.td([], [school.contactPerson]),
                  h.td([], [h.a([h.Href(`tel:${school.phone}`)], [school.phone])]),
                  h.td([], [h.a([h.Href(`mailto:${school.email}`)], [school.email])]),
                  h.td([], [languageLabel(school.language)]),
                  h.td([], [school.departments.map((department) => department.name).join(", ")]),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );
};

const controls = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [
      h.Class("schools-directory__controls"),
      h.OnSubmit(UpdatedSearch({ value: model.searchText })),
    ],
    [
      Input.view(
        {
          id: "schools-directory-search",
          value: model.searchText,
          type: "search",
          placeholder: "Søk etter skole eller kontakt",
          onInput: (value) => UpdatedSearch({ value }),
          toView: ({ input, label, description }) =>
            h.div(
              [h.Class("schools-directory__field")],
              [
                h.label([...label, h.Class("schools-directory__label")], ["Søk"]),
                h.input([...input, h.Class("schools-directory__input")]),
                h.p(
                  [...description, h.Class("schools-directory__hint")],
                  ["Søket filtrerer navn, kontaktinformasjon, språk og avdelinger."],
                ),
              ],
            ),
        },
        h,
      ),
      Select.view(
        {
          id: "schools-directory-department",
          value: model.department ?? "",
          onChange: (value) =>
            SelectedDepartment({
              department: value === "" ? null : DepartmentId.make(value),
            }),
          toView: ({ select, label, description }) =>
            h.div(
              [h.Class("schools-directory__field")],
              [
                h.label([...label, h.Class("schools-directory__label")], ["Avdeling"]),
                h.select(
                  [...select, h.Class("schools-directory__select")],
                  [
                    h.option([h.Value("")], ["Alle avdelinger"]),
                    ...model.knownDepartments.map((department) =>
                      h.option([h.Value(department.departmentId)], [department.name]),
                    ),
                  ],
                ),
                h.p(
                  [...description, h.Class("schools-directory__hint")],
                  ["Velg én avdeling for å avgrense oversikten."],
                ),
              ],
            ),
        },
        h,
      ),
    ],
  );

const successfulDirectory = (
  model: Model,
  directory: SchoolDirectory,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("schools-directory__ready")],
    [
      controls(model, h),
      h.submodel({
        slotId: model.tabs.id,
        model: model.tabs,
        view: SchoolDirectoryTabs.view,
        viewInputs: {
          tabs: ["Active", "Inactive"],
          selectedValue: model.selectedTab,
          ariaLabel: "Skolestatus",
          toView: ({ tablist, tabs }) =>
            h.div(
              [h.Class("schools-directory__results")],
              [
                h.div(
                  [...tablist, h.Class("schools-directory__tablist")],
                  tabs.map((tab) =>
                    h.button(
                      [...tab.tab, h.Class("schools-directory__tab"), h.Type("button")],
                      [
                        tab.value === "Active"
                          ? `Aktive (${directory.activeSchools.length})`
                          : `Inaktive (${directory.inactiveSchools.length})`,
                      ],
                    ),
                  ),
                ),
                ...tabs.map((tab) =>
                  h.section(
                    [...tab.panel, h.Hidden(!tab.isActive), h.Class("schools-directory__panel")],
                    [
                      schoolTable(
                        tab.value === "Active"
                          ? directory.activeSchools
                          : directory.inactiveSchools,
                        tab.value,
                        model.searchText,
                        h,
                      ),
                    ],
                  ),
                ),
              ],
            ),
        },
        toParentMessage: (message) => GotDirectoryTabMessage({ message }),
      }),
    ],
  );

const directoryState = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.match(model.directory, {
    onIdle: () =>
      h.div(
        [h.Class("schools-directory__loading"), h.Role("status"), h.AriaLive("polite")],
        ["Forbereder skoleoversikten …"],
      ),
    onLoading: () =>
      h.div(
        [h.Class("schools-directory__loading"), h.Role("status"), h.AriaLive("polite")],
        [
          h.span([h.Class("schools-directory__spinner"), h.AriaHidden(true)], []),
          "Henter skoler …",
        ],
      ),
    onRefreshing: (directory) => successfulDirectory(model, directory, h),
    onFailure: (failure) =>
      h.section(
        [h.Class("schools-directory__error"), h.Role("alert")],
        [
          h.h2(
            [],
            [failure._tag === "Denied" ? "Ingen tilgang" : "Skoleoversikten kunne ikke hentes"],
          ),
          h.p([], [failure.message]),
          retryButton(h),
        ],
      ),
    onStale: ({ data, error }) =>
      h.div(
        [],
        [
          h.section(
            [h.Class("schools-directory__error"), h.Role("alert")],
            [
              h.h2([], ["Skoleoversikten kunne ikke oppdateres"]),
              h.p([], [error.message]),
              retryButton(h),
            ],
          ),
          successfulDirectory(model, data, h),
        ],
      ),
    onSuccess: (directory) => successfulDirectory(model, directory, h),
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("schools-directory"), h.AriaLabelledBy("schools-directory-title")],
    [
      h.header(
        [h.Class("schools-directory__header")],
        [
          h.p([h.Class("schools-directory__eyebrow")], ["Organisasjon"]),
          h.h1([h.Id("schools-directory-title")], ["Skoler"]),
          h.p(
            [],
            ["Se aktive og inaktive skoler med kontaktinformasjon og tilhørende avdelinger."],
          ),
        ],
      ),
      directoryState(model, h),
    ],
  );
