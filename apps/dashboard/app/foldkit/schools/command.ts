import { DepartmentId } from "@vektorprogrammet/http-api";
import { Effect, Match, Schema as S } from "effect";
import { Command } from "foldkit";
import type { SchoolsBridgeFailure } from "./bridge";
import type { SchoolsDirectoryClient } from "./browser-client";
import {
  FailedDirectory,
  SucceededDirectory,
  SucceededManagement,
  FailedManagement,
  SucceededSchoolCommand,
  FailedSchoolCommand,
  type Message,
} from "./message";
import { SchoolCommand } from "@vektorprogrammet/http-api";
import { nativeProblemFrom } from "../../lib/native-problem";
import { type Model, SchoolDirectoryFailure, SchoolDirectoryRequestId } from "./model";

export interface SchoolsDirectoryCommands {
  readonly LoadManagement: (args: { requestId: number }) => Command.Command<Message>;
  readonly SaveSchool: (args: { command: SchoolCommand }) => Command.Command<Message>;
  readonly LoadDirectory: (args: {
    readonly requestId: S.Schema.Type<typeof SchoolDirectoryRequestId>;
    readonly department: S.Schema.Type<typeof DepartmentId> | null;
  }) => Command.Command<Message>;
}

const failureFrom = (error: SchoolsBridgeFailure): SchoolDirectoryFailure => {
  switch (error.error.tag) {
    case "UnauthenticatedActor":
      return SchoolDirectoryFailure.cases.Denied.make({
        message: "Økten din er utløpt. Logg inn på nytt.",
      });
    case "AuthorityInactive":
      return SchoolDirectoryFailure.cases.Denied.make({
        message: "Tilgangen din til skoleoversikten er ikke aktiv.",
      });
    case "NotInScope":
      return SchoolDirectoryFailure.cases.Denied.make({
        message: "Du har ikke tilgang til skoleoversikten.",
      });
    case "SchoolsDepartmentOutOfScope":
      return SchoolDirectoryFailure.cases.Denied.make({
        message: "Du har ikke tilgang til den valgte avdelingen.",
      });
    default:
      return SchoolDirectoryFailure.cases.Failed.make({
        message: "Skoleoversikten kunne ikke hentes. Prøv på nytt.",
      });
  }
};

export const commandsFor = (client: SchoolsDirectoryClient): SchoolsDirectoryCommands => {
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

  const LoadManagement = Command.define("LoadSchoolManagement", {
    args: { requestId: S.Int },
    messages: [SucceededManagement, FailedManagement],
    execute: ({ requestId }) =>
      client.directory.readManagement().pipe(
        Effect.map((data) =>
          SucceededManagement({ requestId, data, commandId: crypto.randomUUID() }),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            FailedManagement({
              requestId,
              denied:
                nativeProblemFrom(error)?.status === 403 ||
                nativeProblemFrom(error)?.status === 401,
            }),
          ),
        ),
      ),
  });

  const SaveSchool = Command.define("SaveSchoolAdministration", {
    args: { command: SchoolCommand },
    messages: [SucceededSchoolCommand, FailedSchoolCommand],
    execute: ({ command }) =>
      client.directory.executeCommand(command).pipe(
        Effect.map((result) => SucceededSchoolCommand({ commandId: command.commandId, result })),
        Effect.catch((error) => {
          const problem = nativeProblemFrom(error);
          const code = problem?.code;

          const message = Match.value(code).pipe(
            Match.when(
              "schools.association-in-use",
              () =>
                "Avdelingen kan ikke fjernes. Kapasitet eller andre registreringer bruker tilknytningen.",
            ),
            Match.when("authority.denied", () => "Du har ikke lenger tilgang til denne endringen."),
            Match.when(
              "precondition.failed",
              () => "Opplysningene er endret av en annen bruker. Last inn på nytt før du lagrer.",
            ),
            Match.when("schools.inactive", () => "Aktiver skolen før du endrer kapasitet."),
            Match.when(
              "schools.capacity-exists",
              () => "Kapasitetsplanen finnes allerede. Last inn på nytt.",
            ),
            Match.when(
              "schools.invalid-command",
              () => "Kontroller feltene og de valgte avdelingene.",
            ),
            Match.orElse(
              () =>
                "Endringen kunne ikke bekreftes. Prøv samme forespørsel igjen eller last inn på nytt.",
            ),
          );

          return Effect.succeed(
            FailedSchoolCommand({
              command,
              message,
              conflict: problem?.status === 412 || code === "schools.capacity-exists",
            }),
          );
        }),
      ),
  });

  return { LoadDirectory, LoadManagement, SaveSchool };
};

export const initialLoad = (
  commands: SchoolsDirectoryCommands,
  model: Pick<Model, "requestId" | "department">,
): Command.Command<Message> =>
  commands.LoadDirectory({ requestId: model.requestId, department: model.department });
