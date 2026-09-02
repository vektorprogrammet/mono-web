import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import type { SchoolsBridgeFailure } from "./bridge";
import type { SchoolsDirectoryClient } from "./browser-client";
import { FailedDirectory, SucceededDirectory, type Message } from "./message";
import type { Model, SchoolDirectoryFailure } from "./model";
import { SchoolDirectoryRequestId } from "./model";

export interface SchoolsDirectoryCommands {
  readonly LoadDirectory: (args: {
    readonly requestId: S.Schema.Type<typeof SchoolDirectoryRequestId>;
    readonly department: S.Schema.Type<typeof DepartmentId> | null;
  }) => Command.Command<Message>;
}

const failureFrom = (error: SchoolsBridgeFailure): SchoolDirectoryFailure => {
  switch (error.error.tag) {
    case "UnauthenticatedActor":
      return { _tag: "Denied", message: "Økten din er utløpt. Logg inn på nytt." };
    case "AuthorityInactive":
      return { _tag: "Denied", message: "Tilgangen din til skoleoversikten er ikke aktiv." };
    case "NotInScope":
      return { _tag: "Denied", message: "Du har ikke tilgang til skoleoversikten." };
    case "SchoolsDepartmentOutOfScope":
      return { _tag: "Denied", message: "Du har ikke tilgang til den valgte avdelingen." };
    default:
      return {
        _tag: "Failed",
        message: "Skoleoversikten kunne ikke hentes. Prøv på nytt.",
      };
  }
};

export const makeSchoolsDirectoryCommands = (
  client: SchoolsDirectoryClient,
): SchoolsDirectoryCommands => {
  const LoadDirectory = Command.define("LoadSchoolsDirectory", {
    args: {
      requestId: SchoolDirectoryRequestId,
      department: S.NullOr(DepartmentId),
    },
    messages: [SucceededDirectory, FailedDirectory],
    execute: ({ requestId, department }) =>
      client.directory.listSchools(department === null ? {} : { department }).pipe(
        Effect.map((directory) => SucceededDirectory({ requestId, department, directory })),
        Effect.catch((error) =>
          Effect.succeed(FailedDirectory({ requestId, department, failure: failureFrom(error) })),
        ),
      ),
  });

  return { LoadDirectory };
};

export const initialLoad = (
  commands: SchoolsDirectoryCommands,
  model: Pick<Model, "requestId" | "department">,
): Command.Command<Message> =>
  commands.LoadDirectory({ requestId: model.requestId, department: model.department });
