import { Predicate } from "effect";
import { Input, Select } from "@foldkit/ui";
import { SchoolId } from "@vektorprogrammet/http-api";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Model } from "./model";
import {
  OpenedManagement,
  RefreshedManagement,
  SelectedManagedSchool,
  ChangedSchoolField,
  ToggledSchoolDepartment,
  ChangedCapacityField,
  SubmittedSchool,
  RetriedSchoolCommand,
  DiscardedSchoolFailure,
  type Message,
} from "./message";

const days = [
  ["monday", "Mandag"],
  ["tuesday", "Tirsdag"],
  ["wednesday", "Onsdag"],
  ["thursday", "Torsdag"],
  ["friday", "Fredag"],
] as const;

const actions = {
  CreateSchool: "Opprettet skole",
  ReviseSchool: "Endret skole",
  ReplaceSchoolDepartments: "Endret avdelinger",
  CreateCapacity: "Opprettet kapasitet",
  ReviseCapacity: "Endret kapasitet",
} as const;

export const managementView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (model.managementStatus === "Denied") return h.div([], []);

  if (model.managementStatus === "Failed")
    return h.section(
      [h.Role("status")],
      [
        h.p([], ["Administrasjonen kunne ikke hentes."]),
        h.button(
          [h.Type("button"), h.OnClick(RefreshedManagement())],
          ["Prøv administrasjon igjen"],
        ),
      ],
    );

  if (!model.management) return h.p([h.Role("status")], ["Henter vedlikeholdstilgang …"]);
  const data = model.management;
  const selected = data.schools.find((row) => row.school.schoolId === model.selectedSchool);
  const pending = Predicate.isTagged(model.mutation, "Pending");

  const locked =
    pending ||
    Predicate.isTagged(model.mutation, "Failed") ||
    Predicate.isTagged(model.mutation, "Conflict") ||
    model.managementStatus !== "Ready";

  const canEdit = selected === undefined || selected.canEditShared;

  const field = (
    id: string,
    labelText: string,
    value: string,
    onInput: (value: string) => Message,
    disabled = locked,
    type: "text" | "email" | "tel" | "number" = "text",
  ) =>
    Input.view(
      {
        id,
        value,
        type,
        onInput,
        toView: ({ input, label }) =>
          h.div(
            [h.Class("schools-directory__field")],
            [
              h.label([...label, h.Class("schools-directory__label")], [labelText]),
              h.input([
                ...input,
                h.Class("schools-directory__input"),
                h.Disabled(disabled),
                ...(type === "number" ? [h.Min("0"), h.Max("2147483647"), h.Step("1")] : []),
              ]),
            ],
          ),
      },
      h,
    );

  const select = (
    id: string,
    labelText: string,
    value: string,
    options: ReadonlyArray<readonly [string, string]>,
    onChange: (value: string) => Message,
    disabled = locked,
  ) =>
    Select.view(
      {
        id,
        value,
        onChange,
        toView: ({ select, label }) =>
          h.div(
            [h.Class("schools-directory__field")],
            [
              h.label([...label, h.Class("schools-directory__label")], [labelText]),
              h.select(
                [...select, h.Class("schools-directory__select"), h.Disabled(disabled)],
                options.map(([key, name]) => h.option([h.Value(key)], [name])),
              ),
            ],
          ),
      },
      h,
    );

  const associations = () =>
    h.fieldset(
      [h.Disabled(locked || !canEdit), h.Class("schools-management__departments")],
      [
        h.legend([], ["Tilknyttede avdelinger"]),
        ...data.departments.map((department) =>
          h.label(
            [h.Key(department.departmentId), h.Class("schools-management__checkbox")],
            [
              h.input([
                h.Type("checkbox"),
                h.Checked(model.schoolForm.departmentIds.includes(department.departmentId)),
                h.OnClick(ToggledSchoolDepartment({ departmentId: department.departmentId })),
              ]),
              department.name,
            ],
          ),
        ),
      ],
    );

  const save = (label: string, disabled: boolean) =>
    h.button(
      [h.Type("submit"), h.Class("schools-directory__retry"), h.Disabled(disabled)],
      [label],
    );

  const currentCapacity = selected?.capacities.find(
    (row) =>
      row.departmentId === model.capacityForm.departmentId &&
      row.semesterId === model.capacityForm.semesterId,
  );

  const notice: Html[] = Predicate.isTagged(model.mutation, "Idle")
    ? []
    : [
        h.p(
          [h.Role(pending || Predicate.isTagged(model.mutation, "Saved") ? "status" : "alert")],
          [
            pending
              ? "Lagrer endringen …"
              : "message" in model.mutation
                ? model.mutation.message
                : "",
          ],
        ),
      ];

  if (Predicate.isTagged(model.mutation, "Failed"))
    notice.push(
      h.button(
        [h.Type("button"), h.OnClick(RetriedSchoolCommand())],
        ["Prøv samme forespørsel igjen"],
      ),
    );

  if (
    Predicate.isTagged(model.mutation, "Failed") ||
    Predicate.isTagged(model.mutation, "Conflict")
  )
    notice.push(
      h.button(
        [h.Type("button"), h.OnClick(DiscardedSchoolFailure())],
        ["Last inn på nytt og forkast skjemaet"],
      ),
    );

  return h.section(
    [h.Class("schools-management"), h.AriaLabel("Skoleadministrasjon")],
    [
      h.button(
        [h.Type("button"), h.OnClick(OpenedManagement()), h.AriaExpanded(model.managementOpen)],
        [model.managementOpen ? "Lukk administrasjon" : "Administrer skoler"],
      ),
      ...(model.managementOpen
        ? [
            h.h2([], ["Skoleadministrasjon"]),
            h.p(
              [],
              [
                "Skoleopplysninger deles mellom avdelinger. Kapasitet gjelder én avdeling og ett semester, og endrer ikke plasseringsbehov eller vaktlister.",
              ],
            ),
            select(
              "managed-school",
              "Velg skole",
              model.selectedSchool === null ? "" : String(model.selectedSchool),
              [
                ["", "Ny skole"],
                ...data.schools.map((row): readonly [string, string] => [
                  String(row.school.schoolId),
                  row.school.name,
                ]),
              ],
              (value) =>
                SelectedManagedSchool({
                  schoolId: value === "" ? null : SchoolId.make(Number(value)),
                }),
            ),
            h.button(
              [
                h.Type("button"),
                h.Disabled(locked),
                h.OnClick(SelectedManagedSchool({ schoolId: null })),
              ],
              ["Ny skole"],
            ),
            h.button(
              [h.Type("button"), h.Disabled(pending), h.OnClick(RefreshedManagement())],
              ["Oppdater administrasjon"],
            ),
            ...notice,
            ...(selected ? [h.p([], [`Skolerevisjon: ${selected.school.revision}`])] : []),
            ...(!canEdit
              ? [
                  h.p(
                    [],
                    [
                      "Du kan endre kapasitet for dine avdelinger, men ikke skolens delte opplysninger eller tilknytninger.",
                    ],
                  ),
                ]
              : []),
            field("school-reason", "Begrunnelse", model.schoolForm.reason, (value) =>
              ChangedSchoolField({ field: "reason", value }),
            ),
            h.form(
              [h.OnSubmit(SubmittedSchool({ kind: "Facts" })), h.Class("schools-management__form")],
              [
                h.h3([], [selected ? "Skole og kontakt" : "Opprett skole"]),
                field(
                  "school-name",
                  "Skolenavn",
                  model.schoolForm.name,
                  (value) => ChangedSchoolField({ field: "name", value }),
                  locked || !canEdit,
                ),
                field(
                  "school-contact",
                  "Kontaktperson",
                  model.schoolForm.contactPerson,
                  (value) => ChangedSchoolField({ field: "contactPerson", value }),
                  locked || !canEdit,
                ),
                field(
                  "school-email",
                  "E-postadresse",
                  model.schoolForm.email,
                  (value) => ChangedSchoolField({ field: "email", value }),
                  locked || !canEdit,
                  "email",
                ),
                field(
                  "school-phone",
                  "Telefonnummer",
                  model.schoolForm.phone,
                  (value) => ChangedSchoolField({ field: "phone", value }),
                  locked || !canEdit,
                  "tel",
                ),
                select(
                  "school-language",
                  "Undervisningsspråk",
                  model.schoolForm.language,
                  [
                    ["Norwegian", "Norsk"],
                    ["International", "Internasjonal"],
                  ],
                  (value) => ChangedSchoolField({ field: "language", value }),
                  locked || !canEdit,
                ),
                select(
                  "school-active",
                  "Aktiv status",
                  String(model.schoolForm.active),
                  [
                    ["true", "Aktiv"],
                    ["false", "Inaktiv"],
                  ],
                  (value) => ChangedSchoolField({ field: "active", value }),
                  locked || !canEdit,
                ),
                ...(selected === undefined ? [associations()] : []),
                ...(canEdit ? [save("Lagre skole", locked)] : []),
              ],
            ),
            ...(selected && canEdit
              ? [
                  h.form(
                    [
                      h.OnSubmit(SubmittedSchool({ kind: "Departments" })),
                      h.Class("schools-management__form"),
                    ],
                    [
                      h.h3([], ["Avdelingstilknytninger"]),
                      associations(),
                      h.p(
                        [],
                        [
                          "En avdeling kan ikke fjernes når kapasitet eller andre registreringer viser til tilknytningen.",
                        ],
                      ),
                      save("Lagre avdelinger", locked),
                    ],
                  ),
                ]
              : []),
            ...(selected
              ? [
                  h.form(
                    [
                      h.OnSubmit(SubmittedSchool({ kind: "Capacity" })),
                      h.Class("schools-management__form"),
                    ],
                    [
                      h.h3([], ["Kapasitetsplan"]),
                      select(
                        "capacity-department",
                        "Kapasitetsavdeling",
                        model.capacityForm.departmentId,
                        [
                          ["", "Velg avdeling"],
                          ...selected.capacityDepartmentIds.map((id): readonly [string, string] => [
                            id,
                            data.departments.find((row) => row.departmentId === id)?.name ?? id,
                          ]),
                        ],
                        (value) => ChangedCapacityField({ field: "departmentId", value }),
                      ),
                      select(
                        "capacity-semester",
                        "Kapasitetssemester",
                        model.capacityForm.semesterId,
                        [
                          ["", "Velg semester"],
                          ...data.semesters.map((row): readonly [string, string] => [
                            row.semesterId,
                            row.name,
                          ]),
                        ],
                        (value) => ChangedCapacityField({ field: "semesterId", value }),
                      ),
                      h.p(
                        [],
                        [
                          currentCapacity
                            ? `Kapasitetsrevisjon: ${currentCapacity.revision}`
                            : "Ingen lagret plan for valgt avdeling og semester.",
                        ],
                      ),
                      ...days.map(([day, label]) =>
                        field(
                          `capacity-${day}`,
                          label,
                          model.capacityForm[day],
                          (value) => ChangedCapacityField({ field: day, value }),
                          locked || !selected.school.active,
                          "number",
                        ),
                      ),
                      ...(!selected.school.active
                        ? [h.p([], ["Skolen er inaktiv. Lagrede kapasitetsplaner er bevart."])]
                        : []),
                      save(
                        "Lagre kapasitet",
                        locked ||
                          !selected.school.active ||
                          selected.capacityDepartmentIds.length === 0,
                      ),
                      h.h4([], ["Lagrede kapasitetsplaner"]),
                      h.ul(
                        [],
                        selected.capacities.map((plan) =>
                          h.li(
                            [],
                            [
                              `${data.departments.find((row) => row.departmentId === plan.departmentId)?.name ?? plan.departmentId} · ${plan.semesterId} · revisjon ${plan.revision}: ${days.map(([day, label]) => `${label} ${plan[day]}`).join(", ")}`,
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ]
              : []),
            h.section(
              [h.AriaLabel("Skolehistorikk")],
              [
                h.h3([], ["Historikk"]),
                h.ul(
                  [],
                  data.history
                    .filter(
                      (entry) =>
                        model.selectedSchool === null || entry.schoolId === model.selectedSchool,
                    )
                    .map((entry) =>
                      h.li(
                        [],
                        [
                          `${actions[entry.action]} · revisjon ${entry.revision} · ${entry.recordedAt} · ${entry.actorPersonId}: ${entry.reason}`,
                        ],
                      ),
                    ),
                ),
              ],
            ),
          ]
        : []),
    ],
  );
};
