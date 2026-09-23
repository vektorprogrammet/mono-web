import { Runtime } from "foldkit";
import { Input, Model, makeInitialModel } from "./model";
import { update } from "./update";
import { view } from "./view";
import "./styles.css";

export const embedDatedService = (container: HTMLElement, input: Input): (() => void) => {
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => [makeInitialModel(input), []],
    update,
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Role("alert")],
          ["Daterte skoletjenester kunne ikke vises. Last siden på nytt."],
        ),
    },
  });
  const handle = Runtime.embed(program);
  return () => handle.dispose();
};
