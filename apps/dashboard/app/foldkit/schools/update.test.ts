import { DepartmentId, SchoolManagement, SchoolCommandResult } from "@vektorprogrammet/http-api";
import { SchoolId, type SchoolDirectory } from "@vektorprogrammet/http-api";
import { Tabs } from "@foldkit/ui";
import { Effect, Predicate, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { SchoolsDirectoryClient } from "./browser-client";
import { commandsFor } from "./command";
import {
  ChangedCapacityField,
  ChangedSchoolField,
  SelectedManagedSchool,
  SubmittedSchool,
  SucceededManagement,
  SucceededSchoolCommand,
  FailedDirectory,
  GotDirectoryTabMessage,
  RetriedDirectory,
  SelectedDepartment,
  SucceededDirectory,
  UpdatedSearch,
} from "./message";
import { SchoolDirectoryData, init, SchoolDirectoryFailure } from "./model";
import { updateFor } from "./update";

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
  directory: {
    readManagement: () => Effect.die("unexpected management request"),
    executeCommand: () => Effect.die("unexpected school command"),
    listSchools: (input) => {
      listInputs.push(input ?? {});

      return Effect.succeed(directory);
    },
  },
};

const commands = commandsFor(client);

const update = updateFor(commands);

describe("Foldkit Schools directory transitions", () => {
  it("keeps the selected capacity tuple after saving and refreshes its counts and revision", () => {
    const data = Schema.decodeUnknownSync(SchoolManagement)({
      departments: [
        { departmentId: departmentA, name: "A" },
        { departmentId: departmentB, name: "B" },
      ],
      semesters: [
        { semesterId: "semester-a", name: "A" },
        { semesterId: "semester-b", name: "B" },
      ],
      schools: [
        {
          school: {
            schoolId: 1,
            name: "Alfaskolen",
            contactPerson: "Ada",
            email: "ada@example.invalid",
            phone: "12345678",
            language: "Norwegian",
            active: true,
            revision: 0,
          },
          departmentIds: [departmentA, departmentB],
          canEditShared: true,
          capacityDepartmentIds: [departmentA, departmentB],
          capacities: [
            {
              capacityId: 7,
              schoolId: 1,
              departmentId: departmentB,
              semesterId: "semester-b",
              monday: 3,
              tuesday: 0,
              wednesday: 0,
              thursday: 0,
              friday: 0,
              revision: 2,
            },
          ],
        },
      ],
      history: [],
    });

    const commandId = "school-capacity-refresh-command";
    let model = update(init(), SucceededManagement({ requestId: 1, data, commandId })).model;
    model = update(model, SelectedManagedSchool({ schoolId: SchoolId.make(1) })).model;
    model = update(
      model,
      ChangedCapacityField({ field: "departmentId", value: departmentB }),
    ).model;
    model = update(model, ChangedCapacityField({ field: "semesterId", value: "semester-b" })).model;
    model = update(model, ChangedCapacityField({ field: "monday", value: "4" })).model;
    model = update(model, ChangedSchoolField({ field: "reason", value: "Oppdatert avtale" })).model;
    model = update(model, SubmittedSchool({ kind: "Capacity" })).model;
    model = update(
      model,
      SucceededSchoolCommand({
        commandId,
        result: Schema.decodeUnknownSync(SchoolCommandResult)({
          schoolId: 1,
          capacityId: 7,
          revision: 3,
        }),
      }),
    ).model;

    const refreshed = {
      ...data,
      schools: data.schools.map((school) => ({
        ...school,
        capacities: school.capacities.map((capacity) => ({ ...capacity, monday: 4, revision: 3 })),
      })),
    };

    model = update(
      model,
      SucceededManagement({
        requestId: model.managementRequestId,
        data: refreshed,
        commandId: "school-capacity-next-command",
      }),
    ).model;
    expect(model.capacityForm).toMatchObject({
      departmentId: departmentB,
      semesterId: "semester-b",
      monday: "4",
    });
    model = update(model, ChangedSchoolField({ field: "reason", value: "Ny avtale" })).model;
    model = update(model, ChangedCapacityField({ field: "monday", value: "5" })).model;
    model = update(model, SubmittedSchool({ kind: "Capacity" })).model;

    if (!Predicate.isTagged(model.mutation, "Pending"))
      throw new Error("Expected a pending capacity command");
    expect(model.mutation.command._tag).toBe("ReviseCapacity");
    expect(model.mutation.command).toMatchObject({
      departmentId: departmentB,
      semesterId: "semester-b",
      monday: 5,
      expectedRevision: 3,
    });
  });

  it("starts a retry with one new request and ignores a stale result", () => {
    const initial = init();
    const { model: loading, commands: emitted = [] } = update(initial, RetriedDirectory());

    expect(loading.requestId).toBe(2);
    expect(loading.retryCount).toBe(1);
    expect(loading.directory._tag).toBe("Loading");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.args).toEqual({ requestId: 2, department: null });

    const { model: stale, commands: staleCommands = [] } = update(
      loading,
      SucceededDirectory({ requestId: 1, department: null, directory }),
    );

    expect(stale).toBe(loading);
    expect(staleCommands).toEqual([]);
  });

  it("accepts only the active scoped response and retains all-scope filter options", () => {
    const initial = init();

    const { model: ready } = update(
      initial,
      SucceededDirectory({ requestId: 1, department: null, directory }),
    );

    expect(ready.directory).toEqual(SchoolDirectoryData.Success({ data: directory }));
    expect(ready.knownDepartments).toEqual([
      { departmentId: departmentA, name: "Avdeling A" },
      { departmentId: departmentB, name: "Avdeling B" },
    ]);

    const { model: loading, commands: emitted = [] } = update(
      ready,
      SelectedDepartment({ department: departmentB }),
    );

    expect(loading.department).toBe(departmentB);
    expect(loading.requestId).toBe(2);
    expect(loading.knownDepartments).toEqual(ready.knownDepartments);
    expect(emitted[0]?.args).toEqual({ requestId: 2, department: departmentB });

    const { model: wrongScope } = update(
      loading,
      SucceededDirectory({ requestId: 2, department: departmentA, directory }),
    );

    expect(wrongScope).toBe(loading);
  });

  it("owns search and tab selection without a remote command", () => {
    const initial = init();

    const { model: searched, commands: searchCommands = [] } = update(
      initial,
      UpdatedSearch({ value: "alfa" }),
    );

    expect(searched.searchText).toBe("alfa");
    expect(searchCommands).toEqual([]);

    const { model: inactive, commands: tabCommands = [] } = update(
      searched,
      GotDirectoryTabMessage({
        message: Tabs.Message.SelectedTab({ index: 1, value: "Inactive" }),
      }),
    );

    expect(inactive.selectedTab).toBe("Inactive");
    expect(tabCommands).toHaveLength(1);
    expect(tabCommands[0]?.args).toEqual({ id: "schools-directory-tabs", index: 1 });
  });

  it("stores a safe typed failure only for the active request", () => {
    const initial = init(departmentA);

    const { model: failed } = update(
      initial,
      FailedDirectory({
        requestId: 1,
        department: departmentA,
        failure: SchoolDirectoryFailure.cases.Denied.make({ message: "Ingen tilgang." }),
      }),
    );

    expect(failed.directory).toEqual(
      SchoolDirectoryData.Failure({
        error: SchoolDirectoryFailure.cases.Denied.make({ message: "Ingen tilgang." }),
      }),
    );
  });
});
