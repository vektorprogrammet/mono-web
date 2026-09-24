import { Match as M } from "effect";
import { Update } from "foldkit";
import type { OrganizationCatalogCommands } from "./command";
import type { Message } from "./message";
import { OrganizationCatalogData, type Model } from "./model";

export const updateFor =
  ({ LoadCatalog }: OrganizationCatalogCommands) =>
  (model: Model, message: Message): Update.Return<Model, Message> =>
    M.value(message).pipe(
      M.withReturnType<Update.Return<Model, Message>>(),
      M.tagsExhaustive({
        RetriedCatalog: () => {
          const requestId = model.requestId + 1;

          return ({ model: 
            {
              ...model,
              catalog: OrganizationCatalogData.Loading(),
              requestId,
              retryCount: model.retryCount + 1,
            }, commands: [LoadCatalog({ catalogKind: model.catalogKind, requestId })] });
        },
        SucceededTeamCatalog: ({ requestId, catalogKind, snapshot }) =>
          requestId !== model.requestId || catalogKind !== model.catalogKind
            ? ({ model: model, commands: [] })
            : ({ model: { ...model, catalog: OrganizationCatalogData.Success({ data: snapshot }) }, commands: [] }),
        SucceededFieldOfStudyCatalog: ({ requestId, catalogKind, snapshot }) =>
          requestId !== model.requestId || catalogKind !== model.catalogKind
            ? ({ model: model, commands: [] })
            : ({ model: { ...model, catalog: OrganizationCatalogData.Success({ data: snapshot }) }, commands: [] }),
        FailedOrganizationCatalog: ({ requestId, catalogKind, message: failure }) =>
          requestId !== model.requestId || catalogKind !== model.catalogKind
            ? ({ model: model, commands: [] })
            : ({ model: { ...model, catalog: OrganizationCatalogData.Failure({ error: failure }) }, commands: [] }),
      }),
    );
