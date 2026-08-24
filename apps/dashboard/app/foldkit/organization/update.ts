import { Match as M } from "effect";
import { type Command } from "foldkit";
import type { OrganizationCatalogCommands } from "./command";
import type { Message } from "./message";
import { OrganizationCatalogData, type Model } from "./model";

export const makeUpdate =
  ({ LoadCatalog }: OrganizationCatalogCommands) =>
  (model: Model, message: Message): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
    M.value(message).pipe(
      M.withReturnType<readonly [Model, ReadonlyArray<Command.Command<Message>>]>(),
      M.tagsExhaustive({
        RetriedCatalog: () => {
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              catalog: OrganizationCatalogData.Loading(),
              requestId,
              retryCount: model.retryCount + 1,
            },
            [LoadCatalog({ catalogKind: model.catalogKind, requestId })],
          ];
        },
        SucceededTeamCatalog: ({ requestId, catalogKind, snapshot }) =>
          requestId !== model.requestId || catalogKind !== model.catalogKind
            ? [model, []]
            : [{ ...model, catalog: OrganizationCatalogData.Success({ data: snapshot }) }, []],
        SucceededFieldOfStudyCatalog: ({ requestId, catalogKind, snapshot }) =>
          requestId !== model.requestId || catalogKind !== model.catalogKind
            ? [model, []]
            : [{ ...model, catalog: OrganizationCatalogData.Success({ data: snapshot }) }, []],
        FailedOrganizationCatalog: ({ requestId, catalogKind, message: failure }) =>
          requestId !== model.requestId || catalogKind !== model.catalogKind
            ? [model, []]
            : [{ ...model, catalog: OrganizationCatalogData.Failure({ error: failure }) }, []],
      }),
    );
