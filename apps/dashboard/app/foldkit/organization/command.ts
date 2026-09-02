import { Effect, Schema as S } from "effect";
import { Command } from "foldkit";
import type { OrganizationCatalogClient } from "./browser-client";
import {
  FailedOrganizationCatalog,
  SucceededFieldOfStudyCatalog,
  SucceededTeamCatalog,
  type Message,
} from "./message";
import { OrganizationCatalogKind, OrganizationCatalogRequestId } from "./model";

export interface OrganizationCatalogCommands {
  readonly LoadCatalog: (args: {
    readonly catalogKind: S.Schema.Type<typeof OrganizationCatalogKind>;
    readonly requestId: S.Schema.Type<typeof OrganizationCatalogRequestId>;
  }) => Command.Command<Message>;
}

export const makeOrganizationCatalogCommands = (
  client: OrganizationCatalogClient,
): OrganizationCatalogCommands => {
  const LoadCatalog = Command.define("LoadOrganizationCatalog", {
    args: {
      catalogKind: OrganizationCatalogKind,
      requestId: OrganizationCatalogRequestId,
    },
    messages: [SucceededTeamCatalog, SucceededFieldOfStudyCatalog, FailedOrganizationCatalog],
    execute: ({ catalogKind, requestId }) => {
      const failure = () =>
        Effect.succeed(
          FailedOrganizationCatalog({
            requestId,
            catalogKind,
            message:
              catalogKind === "Team"
                ? "Teamoversikten kunne ikke hentes. Prøv på nytt."
                : "Studieretningene kunne ikke hentes. Prøv på nytt.",
          }),
        );

      return catalogKind === "Team"
        ? Effect.all(
            [client.organization.listDepartments(), client.organization.listTeams()] as const,
            { concurrency: 2 },
          ).pipe(
            Effect.map(([freshDepartments, freshTeams]) =>
              SucceededTeamCatalog({
                requestId,
                catalogKind,
                snapshot: {
                  _tag: "Team",
                  departments: freshDepartments,
                  records: freshTeams,
                },
              }),
            ),
            Effect.catch(failure),
          )
        : Effect.all(
            [
              client.organization.listDepartments(),
              client.organization.listFieldOfStudies(),
            ] as const,
            { concurrency: 2 },
          ).pipe(
            Effect.map(([freshDepartments, freshFields]) =>
              SucceededFieldOfStudyCatalog({
                requestId,
                catalogKind,
                snapshot: {
                  _tag: "FieldOfStudy",
                  departments: freshDepartments,
                  records: freshFields,
                },
              }),
            ),
            Effect.catch(failure),
          );
    },
  });

  return { LoadCatalog };
};
