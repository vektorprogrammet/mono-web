import { Runtime } from "foldkit";
import type { ProfileClient } from "./browser-client";
import { commandsFor } from "./command";
import { Model, init, type ProfileInput } from "./model";
import "./styles.css";
import { updateFor } from "./update";
import { view } from "./view";

export interface ProfileRuntimeInput {
  readonly client: ProfileClient;
  readonly commandIdSeed: string;
  readonly initialProfile: ProfileInput;
}

export function embedProfileEditor(container: HTMLElement, input: ProfileRuntimeInput): () => void {
  const commands = commandsFor(input.client);
  const update = updateFor(commands);
  const initialModel = init(input.initialProfile, input.commandIdSeed);

  const program = Runtime.makeElement({
    Model,
    container,
    init: () => ({ model: initialModel, commands: [] }),
    update,
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Class("fk-profile fk-error"), h.Role("alert")],
          [
            h.h1([], ["Profilredigeringen kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);

  return () => handle.dispose();
}
