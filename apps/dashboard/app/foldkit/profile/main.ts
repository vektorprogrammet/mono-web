import { Runtime } from "foldkit";
import type { ProfileClient } from "./browser-client";
import { makeProfileCommands } from "./command";
import { Model, makeInitialModel, type ProfileInput } from "./model";
import "./styles.css";
import { makeUpdate } from "./update";
import { view } from "./view";

export interface ProfileRuntimeInput {
  readonly client: ProfileClient;
  readonly commandIdSeed: string;
  readonly initialProfile: ProfileInput;
}

export function embedProfileEditor(container: HTMLElement, input: ProfileRuntimeInput): () => void {
  const commands = makeProfileCommands(input.client);
  const update = makeUpdate(commands);
  const initialModel = makeInitialModel(input.initialProfile, input.commandIdSeed);
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => [initialModel, []],
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
