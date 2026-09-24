import { SucceededDirectory, FailedDirectory } from "./message";
import { SchoolDirectoryFailure } from "./model";
import { DepartmentId } from "@vektorprogrammet/http-api"
import { SchoolId, type SchoolDirectory } from "@vektorprogrammet/http-api"
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { SchoolsDirectoryClient } from "./browser-client";
import { schoolsBridgeFailure } from "./bridge";
import { commandsFor } from "./command";

const department = DepartmentId.make("department-a");

const directory: SchoolDirectory = {
  activeSchools: [
    {
      schoolId: SchoolId.make(1),
      name: "Alfaskolen",
      contactPerson: "Ada Lovelace",
      email: "ada@example.invalid",
      phone: "+47 111 11 111",
      language: "Norwegian",
      departments: [{ departmentId: department, name: "Avdeling A" }],
      isActive: true,
    },
  ],
  inactiveSchools: [],
};

const departmentFailure = schoolsBridgeFailure("SchoolsDepartmentOutOfScope");

const persistenceFailure = schoolsBridgeFailure("SchoolsPersistenceError");

describe("Foldkit Schools directory commands", () => {
  it("makes exactly one scoped native SDK request and returns the full directory", async () => {
    const inputs: Array<unknown> = [];

    const client: SchoolsDirectoryClient = {
      directory: {
        listSchools: (input) => {
          inputs.push(input);

          return Effect.succeed(directory);
        },
      },
    };

    const command = commandsFor(client).LoadDirectory({
      requestId: 4,
      department,
    });

    const message = await Effect.runPromise(command.effect);

    expect(inputs).toEqual([{ department }]);
    expect(message).toEqual(SucceededDirectory({
      requestId: 4,
      department,
      directory,
    }));
  });

  it("maps authority denials and operational failures to safe UI messages", async () => {
    const failures = [departmentFailure, persistenceFailure] as const;

    const messages = await Promise.all(
      failures.map((failure, index) => {
        const client: SchoolsDirectoryClient = {
          directory: {
            listSchools: () => Effect.fail(failure),
          },
        };

        return Effect.runPromise(
          commandsFor(client).LoadDirectory({
            requestId: index + 1,
            department: null,
          }).effect,
        );
      }),
    );

    expect(messages).toEqual([
      FailedDirectory({
        requestId: 1,
        department: null,
        failure: SchoolDirectoryFailure.cases.Denied.make({
          message: "Du har ikke tilgang til den valgte avdelingen.",
        }),
      }),
      FailedDirectory({
        requestId: 2,
        department: null,
        failure: SchoolDirectoryFailure.cases.Failed.make({
          message: "Skoleoversikten kunne ikke hentes. Prøv på nytt.",
        }),
      }),
    ]);
  });
});
