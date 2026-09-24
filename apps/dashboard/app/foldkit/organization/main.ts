import { Runtime } from "foldkit";
import type { OrganizationCatalogClient } from "./browser-client";
import { commandsFor } from "./command";
import { Model, init, type OrganizationCatalogKind } from "./model";
import "./styles.css";
import { updateFor } from "./update";
import { view } from "./view";

export interface OrganizationCatalogRuntimeInput {
  readonly catalogKind: OrganizationCatalogKind;
  readonly client: OrganizationCatalogClient;
}

export const embedOrganizationCatalog = (
  container: HTMLElement,
  input: OrganizationCatalogRuntimeInput,
): (() => void) => {
  const commands = commandsFor(input.client);
  const initialModel = init(input.catalogKind);

  const program = Runtime.makeElement({
    Model,
    container,
    init: () => ({ model: 
      initialModel, commands: [commands.LoadCatalog({ catalogKind: initialModel.catalogKind, requestId: initialModel.requestId })] }),
    update: updateFor(commands),
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Class("organization-catalog organization-catalog__error"), h.Role("alert")],
          [
            h.h1([], ["Organisasjonsoversikten kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);

  return () => handle.dispose();
};
