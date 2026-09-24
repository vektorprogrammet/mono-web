import type { SchoolDirectory, SchoolDirectoryDepartment } from "@vektorprogrammet/http-api";
import { Tabs } from "@foldkit/ui";
import { Match as M, Option, Schema, Predicate } from "effect";
import {
  SchoolCommand,
  DepartmentId,
  SemesterId,
  type SchoolManagement,
} from "@vektorprogrammet/http-api";
import { Command, Update } from "foldkit";
import type { SchoolsDirectoryCommands } from "./command";
import { GotDirectoryTabMessage, type Message } from "./message";
import {
  SchoolDirectoryData,
  SchoolDirectoryTabs,
  SchoolMutation,
  emptySchoolForm,
  emptyCapacityForm,
  type Model,
} from "./model";

const mapTabCommands = (commands: ReadonlyArray<Command.Command<Tabs.Message>>) =>
  Command.mapMessages(commands, (message) => GotDirectoryTabMessage({ message }));

const knownDepartmentsFrom = (
  directory: SchoolDirectory,
): ReadonlyArray<SchoolDirectoryDepartment> => {
  const departments = new Map<string, SchoolDirectoryDepartment>();

  const collect = (schools: SchoolDirectory["activeSchools"]) => {
    for (const school of schools) {
      for (const department of school.departments) {
        departments.set(department.departmentId, department);
      }
    }
  };

  collect(directory.activeSchools);
  collect(directory.inactiveSchools);

  return [...departments.values()].sort((left, right) =>
    left.departmentId === right.departmentId ? 0 : left.departmentId < right.departmentId ? -1 : 1,
  );
};

const selectedForms = (
  data: SchoolManagement | null,
  schoolId: Model["selectedSchool"],
  capacitySelection?: Pick<Model["capacityForm"], "departmentId" | "semesterId">,
): Pick<Model, "schoolForm" | "capacityForm"> => {
  const selected = data?.schools.find((row) => row.school.schoolId === schoolId);

  if (!selected) return { schoolForm: emptySchoolForm(), capacityForm: emptyCapacityForm() };
  const school = selected.school;

  return {
    schoolForm: {
      name: school.name,
      contactPerson: school.contactPerson,
      email: school.email,
      phone: school.phone,
      language: school.language,
      active: school.active,
      departmentIds: selected.departmentIds,
      reason: "",
    },
    capacityForm: {
      ...emptyCapacityForm(),
      departmentId:
        capacitySelection &&
        selected.capacityDepartmentIds.some((id) => id === capacitySelection.departmentId)
          ? capacitySelection.departmentId
          : (selected.capacityDepartmentIds[0] ?? ""),
      semesterId:
        capacitySelection &&
        data?.semesters.some((semester) => semester.semesterId === capacitySelection.semesterId)
          ? capacitySelection.semesterId
          : (data?.semesters[0]?.semesterId ?? ""),
    },
  };
};

const capacityValues = (model: Model, form: Model["capacityForm"]): Model["capacityForm"] => {
  const plan = model.management?.schools
    .find((row) => row.school.schoolId === model.selectedSchool)
    ?.capacities.find(
      (row) => row.departmentId === form.departmentId && row.semesterId === form.semesterId,
    );

  return {
    ...form,
    monday: String(plan?.monday ?? 0),
    tuesday: String(plan?.tuesday ?? 0),
    wednesday: String(plan?.wednesday ?? 0),
    thursday: String(plan?.thursday ?? 0),
    friday: String(plan?.friday ?? 0),
  };
};

export const updateFor =
  ({ LoadDirectory, LoadManagement, SaveSchool }: SchoolsDirectoryCommands) =>
  (model: Model, message: Message): Update.Return<Model, Message> => {
    const locked =
      Predicate.isTagged(model.mutation, "Pending") ||
      Predicate.isTagged(model.mutation, "Failed") ||
      Predicate.isTagged(model.mutation, "Conflict") ||
      model.managementStatus !== "Ready";

    return M.value(message).pipe(
      M.withReturnType<Update.Return<Model, Message>>(),
      M.tagsExhaustive({
        OpenedManagement: () => ({
          model: { ...model, managementOpen: !model.managementOpen },
          commands: [],
        }),
        RefreshedManagement: () =>
          Predicate.isTagged(model.mutation, "Pending")
            ? { model, commands: [] }
            : {
                model: {
                  ...model,
                  managementStatus: "Loading",
                  managementRequestId: model.managementRequestId + 1,
                  mutation: SchoolMutation.cases.Idle.make({}),
                },
                commands: [LoadManagement({ requestId: model.managementRequestId + 1 })],
              },
        DiscardedSchoolFailure: () => ({
          model: {
            ...model,
            managementStatus: "Loading",
            managementRequestId: model.managementRequestId + 1,
            mutation: SchoolMutation.cases.Idle.make({}),
          },
          commands: [LoadManagement({ requestId: model.managementRequestId + 1 })],
        }),
        SelectedManagedSchool: ({ schoolId }) => {
          if (locked) return { model, commands: [] };

          const selected = {
            ...model,
            selectedSchool: schoolId,
            ...selectedForms(model.management, schoolId),
            mutation: SchoolMutation.cases.Idle.make({}),
          };

          return {
            model: { ...selected, capacityForm: capacityValues(selected, selected.capacityForm) },
            commands: [],
          };
        },
        ChangedSchoolField: ({ field, value }) =>
          locked
            ? { model, commands: [] }
            : {
                model: {
                  ...model,
                  schoolForm: {
                    ...model.schoolForm,
                    [field]: M.value(field).pipe(
                      M.when("active", () => value === "true"),
                      M.when("language", () =>
                        value === "International" ? "International" : "Norwegian",
                      ),
                      M.orElse(() => value),
                    ),
                  },
                },
                commands: [],
              },
        ToggledSchoolDepartment: ({ departmentId }) =>
          locked
            ? { model, commands: [] }
            : {
                model: {
                  ...model,
                  schoolForm: {
                    ...model.schoolForm,
                    departmentIds: model.schoolForm.departmentIds.includes(departmentId)
                      ? model.schoolForm.departmentIds.filter((id) => id !== departmentId)
                      : [...model.schoolForm.departmentIds, departmentId],
                  },
                },
                commands: [],
              },
        ChangedCapacityField: ({ field, value }) => {
          if (locked) return { model, commands: [] };
          const form = { ...model.capacityForm, [field]: value };

          return {
            model: {
              ...model,
              capacityForm:
                field === "departmentId" || field === "semesterId"
                  ? capacityValues(model, form)
                  : form,
            },
            commands: [],
          };
        },
        SucceededManagement: ({ requestId, data, commandId }) => {
          if (requestId !== model.managementRequestId) return { model, commands: [] };

          const next: Model = {
            ...model,
            management: data,
            managementStatus: "Ready",
            commandId,
            ...selectedForms(data, model.selectedSchool, model.capacityForm),
          };

          return {
            model: { ...next, capacityForm: capacityValues(next, next.capacityForm) },
            commands: [],
          };
        },
        FailedManagement: ({ requestId, denied }) =>
          requestId !== model.managementRequestId
            ? { model, commands: [] }
            : {
                model: {
                  ...model,
                  management: null,
                  managementStatus: denied ? "Denied" : "Failed",
                },
                commands: [],
              },
        SucceededSchoolCommand: ({ commandId, result }) => {
          if (
            !Predicate.isTagged(model.mutation, "Pending") ||
            model.mutation.command.commandId !== commandId
          )
            return { model, commands: [] };

          const requestId = model.requestId + 1,
            managementRequestId = model.managementRequestId + 1;

          return {
            model: {
              ...model,
              selectedSchool: result.schoolId,
              managementStatus: "Loading",
              managementRequestId,
              requestId,
              mutation: SchoolMutation.cases.Saved.make({ message: "Endringen er lagret." }),
            },
            commands: [
              LoadManagement({ requestId: managementRequestId }),
              LoadDirectory({ requestId, department: model.department }),
            ],
          };
        },
        FailedSchoolCommand: ({ command, conflict, message: detail }) =>
          !Predicate.isTagged(model.mutation, "Pending") ||
          model.mutation.command.commandId !== command.commandId
            ? { model, commands: [] }
            : {
                model: {
                  ...model,
                  mutation: conflict
                    ? SchoolMutation.cases.Conflict.make({ message: detail })
                    : SchoolMutation.cases.Failed.make({ command, message: detail }),
                },
                commands: [],
              },
        RetriedSchoolCommand: () =>
          !Predicate.isTagged(model.mutation, "Failed")
            ? { model, commands: [] }
            : {
                model: {
                  ...model,
                  mutation: SchoolMutation.cases.Pending.make({ command: model.mutation.command }),
                },
                commands: [SaveSchool({ command: model.mutation.command })],
              },
        SubmittedSchool: ({ kind }) => {
          if (locked || model.management === null) return { model, commands: [] };

          const selected = model.management.schools.find(
            (row) => row.school.schoolId === model.selectedSchool,
          );

          const form = model.schoolForm;
          const common = { commandId: model.commandId, reason: form.reason };
          let decoded: Option.Option<SchoolCommand> = Option.none();

          if (kind === "Facts") {
            const facts = {
              name: form.name,
              contactPerson: form.contactPerson,
              email: form.email,
              phone: form.phone,
              language: form.language,
              active: form.active,
            };

            decoded = selected
              ? SchoolCommand.cases.ReviseSchool.makeOption({
                  ...common,
                  ...facts,
                  schoolId: selected.school.schoolId,
                  expectedRevision: selected.school.revision,
                })
              : SchoolCommand.cases.CreateSchool.makeOption({
                  ...common,
                  ...facts,
                  departmentIds: form.departmentIds,
                });
          } else if (kind === "Departments" && selected) {
            decoded = SchoolCommand.cases.ReplaceSchoolDepartments.makeOption({
              ...common,
              schoolId: selected.school.schoolId,
              expectedRevision: selected.school.revision,
              departmentIds: form.departmentIds,
            });
          } else if (kind === "Capacity" && selected) {
            const capacity = model.capacityForm;

            const current = selected.capacities.find(
              (row) =>
                row.departmentId === capacity.departmentId &&
                row.semesterId === capacity.semesterId,
            );

            const counts = {
              monday: capacity.monday === "" ? Number.NaN : Number(capacity.monday),
              tuesday: capacity.tuesday === "" ? Number.NaN : Number(capacity.tuesday),
              wednesday: capacity.wednesday === "" ? Number.NaN : Number(capacity.wednesday),
              thursday: capacity.thursday === "" ? Number.NaN : Number(capacity.thursday),
              friday: capacity.friday === "" ? Number.NaN : Number(capacity.friday),
            };

            const refs = Schema.decodeUnknownOption(
              Schema.Struct({ departmentId: DepartmentId, semesterId: SemesterId }),
            )(capacity);

            if (Option.isSome(refs)) {
              const scope = {
                schoolId: selected.school.schoolId,
                ...refs.value,
                expectedSchoolRevision: selected.school.revision,
              };

              decoded = current
                ? SchoolCommand.cases.ReviseCapacity.makeOption({
                    ...common,
                    ...scope,
                    ...counts,
                    expectedRevision: current.revision,
                  })
                : SchoolCommand.cases.CreateCapacity.makeOption({ ...common, ...scope, ...counts });
            }
          }

          if (Option.isNone(decoded))
            return {
              model: {
                ...model,
                mutation: SchoolMutation.cases.Invalid.make({
                  message:
                    "Fyll ut alle feltene, velg minst én avdeling, og oppgi en begrunnelse. Kapasitet må være hele, ikke-negative tall.",
                }),
              },
              commands: [],
            };

          return {
            model: {
              ...model,
              mutation: SchoolMutation.cases.Pending.make({ command: decoded.value }),
            },
            commands: [SaveSchool({ command: decoded.value })],
          };
        },

        RetriedDirectory: () => {
          const requestId = model.requestId + 1;

          return {
            model: {
              ...model,
              directory: SchoolDirectoryData.Loading(),
              requestId,
              retryCount: model.retryCount + 1,
            },
            commands: [LoadDirectory({ requestId, department: model.department })],
          };
        },
        UpdatedSearch: ({ value }) => ({ model: { ...model, searchText: value }, commands: [] }),
        SelectedDepartment: ({ department }) => {
          if (department === model.department) return { model: model, commands: [] };
          const requestId = model.requestId + 1;

          return {
            model: {
              ...model,
              directory: SchoolDirectoryData.Loading(),
              requestId,
              department,
            },
            commands: [LoadDirectory({ requestId, department })],
          };
        },
        GotDirectoryTabMessage: ({ message: tabMessage }) => {
          const {
            model: tabs,
            commands: tabCommands = [],
            outMessage: output,
          } = SchoolDirectoryTabs.update(model.tabs, tabMessage);

          return {
            model: {
              ...model,
              tabs,
              selectedTab: output !== undefined ? output.value : model.selectedTab,
            },
            commands: mapTabCommands(tabCommands),
          };
        },
        SucceededDirectory: ({ requestId, department, directory }) =>
          requestId !== model.requestId || department !== model.department
            ? { model: model, commands: [] }
            : {
                model: {
                  ...model,
                  directory: SchoolDirectoryData.Success({ data: directory }),
                  knownDepartments:
                    department === null ? knownDepartmentsFrom(directory) : model.knownDepartments,
                },
                commands: [],
              },
        FailedDirectory: ({ requestId, department, failure }) =>
          requestId !== model.requestId || department !== model.department
            ? { model: model, commands: [] }
            : {
                model: { ...model, directory: SchoolDirectoryData.Failure({ error: failure }) },
                commands: [],
              },
      }),
    );
  };
