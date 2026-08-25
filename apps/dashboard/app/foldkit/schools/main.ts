import { Runtime } from "foldkit";
import type { SchoolsDirectoryClient } from "./browser-client";
import { initialLoad, makeSchoolsDirectoryCommands } from "./command";
import { Model, makeInitialModel } from "./model";
import "./styles.css";
import { makeUpdate } from "./update";
import { view } from "./view";

export interface SchoolsDirectoryRuntimeInput {
  readonly client: SchoolsDirectoryClient;
}

export const embedSchoolsDirectory = (
  container: HTMLElement,
  input: SchoolsDirectoryRuntimeInput,
): (() => void) => {
  const commands = makeSchoolsDirectoryCommands(input.client);
  const initialModel = makeInitialModel();
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => [initialModel, [initialLoad(commands, initialModel)]],
    update: makeUpdate(commands),
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Class("schools-directory schools-directory__error"), h.Role("alert")],
          [
            h.h1([], ["Skoleoversikten kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);
  return () => handle.dispose();
};
