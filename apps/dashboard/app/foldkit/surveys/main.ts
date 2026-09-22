import { Runtime } from "foldkit";
import type { SchoolSurveysClient } from "./browser-client";
import { makeSchoolSurveysCommands } from "./command";
import { Model, makeInitialModel } from "./model";
import "./styles.css";
import { makeUpdate } from "./update";
import { view } from "./view";

export interface SchoolSurveysRuntimeInput {
  readonly client: SchoolSurveysClient;
}

export const embedSchoolSurveys = (
  container: HTMLElement,
  input: SchoolSurveysRuntimeInput,
): (() => void) => {
  const commands = makeSchoolSurveysCommands(input.client);
  const initialModel = makeInitialModel();
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => [initialModel, [commands.LoadCatalog({ requestId: 1 })]],
    update: makeUpdate(commands),
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
