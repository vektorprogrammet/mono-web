import { Runtime } from "foldkit";
import type { SchoolSurveysClient } from "./browser-client";
import { commandsFor } from "./command";
import { Model, init } from "./model";
import "./styles.css";
import { updateFor } from "./update";
import { view } from "./view";

export interface SchoolSurveysRuntimeInput {
  readonly client: SchoolSurveysClient;
}

export const embedSchoolSurveys = (
  container: HTMLElement,
  input: SchoolSurveysRuntimeInput,
): (() => void) => {
  const commands = commandsFor(input.client);
  const initialModel = init();

  const program = Runtime.makeElement({
    Model,
    container,
    init: () => ({ model: initialModel, commands: [commands.LoadCatalog({ requestId: 1 })] }),
    update: updateFor(commands),
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Class("school-surveys school-surveys__error"), h.Role("alert")],
          [
            h.h1([], ["Undersøkelsene kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);

  return () => handle.dispose();
};
