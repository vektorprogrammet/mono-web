import { DepartmentId, SchoolId, type SchoolDirectory } from "@vektorprogrammet/sdk/effect";
import { Tabs } from "@foldkit/ui";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { SchoolsDirectoryClient } from "./browser-client";
import { makeSchoolsDirectoryCommands } from "./command";
import {
  FailedDirectory,
  GotDirectoryTabMessage,
  RetriedDirectory,
  SelectedDepartment,
  SucceededDirectory,
  UpdatedSearch,
} from "./message";
import { SchoolDirectoryData, makeInitialModel } from "./model";
import { makeUpdate } from "./update";

const departmentA = DepartmentId.make("department-a");
const departmentB = DepartmentId.make("department-b");
const directory: SchoolDirectory = {
  activeSchools: [
    {
      schoolId: SchoolId.make(1),
      name: "Alfaskolen",
      contactPerson: "Ada Lovelace",
      email: "ada@example.invalid",
      phone: "+47 111 11 111",
      language: "Norwegian",
      departments: [
        { departmentId: departmentA, name: "Avdeling A" },
        { departmentId: departmentB, name: "Avdeling B" },
      ],
      isActive: true,
    },
  ],
  inactiveSchools: [],
};

const listInputs: Array<{ readonly department?: typeof DepartmentId.Type }> = [];
const client: SchoolsDirectoryClient = {
  admin: {
    schools: {
      list: (input = {}) => {
        listInputs.push(input);
        return Effect.succeed(directory);
      },
    },
  },
};
const commands = makeSchoolsDirectoryCommands(client);
const update = makeUpdate(commands);

describe("Foldkit Schools directory transitions", () => {
  it("starts a retry with one new request and ignores a stale result", () => {
    const initial = makeInitialModel();
    const [loading, emitted] = update(initial, RetriedDirectory());

    expect(loading.requestId).toBe(2);
    expect(loading.retryCount).toBe(1);
    expect(loading.directory._tag).toBe("Loading");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.args).toEqual({ requestId: 2, department: null });

    const [stale, staleCommands] = update(
      loading,
      SucceededDirectory({ requestId: 1, department: null, directory }),
    );
    expect(stale).toBe(loading);
    expect(staleCommands).toEqual([]);
  });

  it("accepts only the active scoped response and retains all-scope filter options", () => {
    const initial = makeInitialModel();
    const [ready] = update(
      initial,
      SucceededDirectory({ requestId: 1, department: null, directory }),
    );
    expect(ready.directory).toEqual(SchoolDirectoryData.Success({ data: directory }));
    expect(ready.knownDepartments).toEqual([
      { departmentId: departmentA, name: "Avdeling A" },
      { departmentId: departmentB, name: "Avdeling B" },
    ]);

    const [loading, emitted] = update(ready, SelectedDepartment({ department: departmentB }));
    expect(loading.department).toBe(departmentB);
    expect(loading.requestId).toBe(2);
    expect(loading.knownDepartments).toEqual(ready.knownDepartments);
    expect(emitted[0]?.args).toEqual({ requestId: 2, department: departmentB });

    const [wrongScope] = update(
      loading,
      SucceededDirectory({ requestId: 2, department: departmentA, directory }),
    );
    expect(wrongScope).toBe(loading);
  });

  it("owns search and tab selection without a remote command", () => {
    const initial = makeInitialModel();
    const [searched, searchCommands] = update(initial, UpdatedSearch({ value: "alfa" }));
    expect(searched.searchText).toBe("alfa");
    expect(searchCommands).toEqual([]);

    const [inactive, tabCommands] = update(
      searched,
      GotDirectoryTabMessage({ message: Tabs.SelectedTab({ index: 1, value: "Inactive" }) }),
    );
    expect(inactive.selectedTab).toBe("Inactive");
    expect(tabCommands).toHaveLength(1);
    expect(tabCommands[0]?.args).toEqual({ id: "schools-directory-tabs", index: 1 });
  });

  it("stores a safe typed failure only for the active request", () => {
    const initial = makeInitialModel(departmentA);
    const [failed] = update(
      initial,
      FailedDirectory({
        requestId: 1,
        department: departmentA,
        failure: { _tag: "Denied", message: "Ingen tilgang." },
      }),
    );
    expect(failed.directory).toEqual(
      SchoolDirectoryData.Failure({
        error: { _tag: "Denied", message: "Ingen tilgang." },
      }),
    );
  });
});
