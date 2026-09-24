import { RetriedWorkspace } from "./message";
import { commandsFor } from "./command";
import type { ContentWorkspaceClient } from "./browser-client";
import { Runtime } from "foldkit";
import { Model, init } from "./model";
import "./styles.css";
import { updateFor } from "./update";
import { view } from "./view";

export interface ContentWorkspaceRuntimeInput {
  readonly client: ContentWorkspaceClient;
}

export const embedContentWorkspace = (
  container: HTMLElement,
  input: ContentWorkspaceRuntimeInput,
): (() => void) => {
  const commandFactories = commandsFor(input.client);
  const initialModel = init();

  const program = Runtime.makeElement({
    Model,
    container,
    init: () => updateFor(commandFactories)(initialModel, RetriedWorkspace({})),
    update: updateFor(commandFactories),
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Class("content-workspace content-workspace__error"), h.Role("alert")],
          [
            h.h1([], ["Artikkeladministrasjonen kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);

  return () => handle.dispose();
};
