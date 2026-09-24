import type { SchoolDirectory,
SchoolDirectoryDepartment, } from "@vektorprogrammet/http-api"
import { Tabs } from "@foldkit/ui";
import { Match as M } from "effect";
import { Command, Update } from "foldkit";
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

export const updateFor =
  ({ LoadDirectory }: SchoolsDirectoryCommands) =>
  (model: Model, message: Message): Update.Return<Model, Message> =>
    M.value(message).pipe(
      M.withReturnType<Update.Return<Model, Message>>(),
      M.tagsExhaustive({
        RetriedDirectory: () => {
          const requestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              directory: SchoolDirectoryData.Loading(),
              requestId,
              retryCount: model.retryCount + 1,
            }, commands: [LoadDirectory({ requestId, department: model.department })] });
        },
        UpdatedSearch: ({ value }) => ({ model: { ...model, searchText: value }, commands: [] }),
        SelectedDepartment: ({ department }) => {
          if (department === model.department) return ({ model: model, commands: [] });
          const requestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              directory: SchoolDirectoryData.Loading(),
              requestId,
              department,
            }, commands: [LoadDirectory({ requestId, department })] });
        },
        GotDirectoryTabMessage: ({ message: tabMessage }) => {
          const { model: tabs, commands: tabCommands = [], outMessage: output } = SchoolDirectoryTabs.update(model.tabs, tabMessage);

          return ({ model: 
            {
              ...model,
              tabs,
              selectedTab: output !== undefined ? output.value : model.selectedTab,
            }, commands: mapTabCommands(tabCommands) });
        },
        SucceededDirectory: ({ requestId, department, directory }) =>
          requestId !== model.requestId || department !== model.department
            ? ({ model: model, commands: [] })
            : ({ model: 
                {
                  ...model,
                  directory: SchoolDirectoryData.Success({ data: directory }),
                  knownDepartments:
                    department === null ? knownDepartmentsFrom(directory) : model.knownDepartments,
                }, commands: [] }),
        FailedDirectory: ({ requestId, department, failure }) =>
          requestId !== model.requestId || department !== model.department
            ? ({ model: model, commands: [] })
            : ({ model: { ...model, directory: SchoolDirectoryData.Failure({ error: failure }) }, commands: [] }),
      }),
    );
