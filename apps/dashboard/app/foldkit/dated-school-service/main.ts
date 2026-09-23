import { Runtime } from "foldkit";
import { Input, Model, makeInitialModel } from "./model";
import { update } from "./update";
import { view } from "./view";
import "./styles.css";

export const embedDatedService = (container: HTMLElement, input: Input): (() => void) => {
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => {
      console.info("DATED-SERVICE-INIT");
      return [makeInitialModel(input), []];
    },
    update,
    view: (model, h) => {
      console.info("DATED-SERVICE-VIEW");
      return view(model, h);
    },
    devTools: false,
    slow: false,
    crash: {
      report: ({ error }) => console.error("DATED-SERVICE-CRASH", error),
      view: (_context, h) =>
        h.section(
          [h.Role("alert")],
          ["Daterte skoletjenester kunne ikke vises. Last siden på nytt."],
        ),
    },
  });
  console.info("DATED-SERVICE-EMBED");
  const handle = Runtime.embed(program);
  return () => handle.dispose();
};
