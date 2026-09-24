import { Runtime } from "foldkit";
import type { SocialEventsClient } from "./browser-client";
import { commandsFor } from "./command";
import { Model, init } from "./model";
import "./styles.css";
import { updateFor } from "./update";
import { view } from "./view";

export interface SocialEventsRuntimeInput {
  readonly client: SocialEventsClient;
}

export const embedSocialEvents = (
  container: HTMLElement,
  input: SocialEventsRuntimeInput,
): (() => void) => {
  const commands = commandsFor(input.client);
  const initialModel = init();

  const program = Runtime.makeElement({
    Model,
    container,
    init: () => ({ model: initialModel, commands: [commands.LoadScope({ requestId: initialModel.requestId })] }),
    update: updateFor(commands),
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Class("social-events social-events__error"), h.Role("alert")],
          [
            h.h1([], ["Arrangementene kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);

  return () => handle.dispose();
};
