import type { SchoolDirectory, SchoolDirectoryDepartment } from "@vektorprogrammet/sdk/effect";
import { Tabs } from "@foldkit/ui";
import { Match as M, Option } from "effect";
import { Command } from "foldkit";
import type { SchoolsDirectoryCommands } from "./command";
import { GotDirectoryTabMessage, type Message } from "./message";
import { SchoolDirectoryData, SchoolDirectoryTabs, type Model } from "./model";

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

export const makeUpdate =
  ({ LoadDirectory }: SchoolsDirectoryCommands) =>
  (model: Model, message: Message): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
    M.value(message).pipe(
      M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
      M.tagsExhaustive({
        RetriedDirectory: () => {
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              directory: SchoolDirectoryData.Loading(),
              requestId,
              retryCount: model.retryCount + 1,
            },
            [LoadDirectory({ requestId, department: model.department })],
          ];
        },
        UpdatedSearch: ({ value }) => [{ ...model, searchText: value }, []],
        SelectedDepartment: ({ department }) => {
          if (department === model.department) return [model, []];
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              directory: SchoolDirectoryData.Loading(),
              requestId,
              department,
            },
            [LoadDirectory({ requestId, department })],
          ];
        },
        GotDirectoryTabMessage: ({ message: tabMessage }) => {
          const [tabs, tabCommands, output] = SchoolDirectoryTabs.update(model.tabs, tabMessage);
          return [
            {
              ...model,
              tabs,
              selectedTab: Option.isSome(output) ? output.value.value : model.selectedTab,
            },
            mapTabCommands(tabCommands),
          ];
        },
        SucceededDirectory: ({ requestId, department, directory }) =>
          requestId !== model.requestId || department !== model.department
            ? [model, []]
            : [
                {
                  ...model,
                  directory: SchoolDirectoryData.Success({ data: directory }),
                  knownDepartments:
                    department === null ? knownDepartmentsFrom(directory) : model.knownDepartments,
                },
                [],
              ],
        FailedDirectory: ({ requestId, department, failure }) =>
          requestId !== model.requestId || department !== model.department
            ? [model, []]
            : [{ ...model, directory: SchoolDirectoryData.Failure({ error: failure }) }, []],
      }),
    );
