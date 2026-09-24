import { Runtime } from "foldkit";
import { commandsFor } from "./command";
import { Model, init, type Mode } from "./model";
import { updateFor } from "./update";
import { view } from "./view";
import "./styles.css";

export const embedRecruitmentMaintenance = (container: HTMLElement, mode: Mode): (() => void) => {
  const commands = commandsFor();
  const model = init(mode);

  const program = Runtime.makeElement({
    Model,
    container,
    init: () => ({ model, commands: [commands.Load({ mode, requestId: model.requestId })] }),
    update: updateFor(commands),
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Class("recruitment-maintenance"), h.Role("alert")],
          [
            h.h1([], ["Vedlikehold kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);

  return () => handle.dispose();
};
