import { Runtime } from "foldkit";
import type { SocialEventsClient } from "./browser-client";
import { makeSocialEventsCommands } from "./command";
import { Model, makeInitialModel } from "./model";
import "./styles.css";
import { makeUpdate } from "./update";
import { view } from "./view";

export interface SocialEventsRuntimeInput {
  readonly client: SocialEventsClient;
}

export const embedSocialEvents = (
  container: HTMLElement,
  input: SocialEventsRuntimeInput,
): (() => void) => {
  const commands = makeSocialEventsCommands(input.client);
  const initialModel = makeInitialModel();
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => [initialModel, [commands.LoadScope({ requestId: initialModel.requestId })]],
    update: makeUpdate(commands),
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
