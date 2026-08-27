import { Schema as S } from "effect";
import { Runtime } from "foldkit";
import type { RecruitmentClient } from "../recruitment/browser-client";
import { makeSchedulingCommands } from "./command";
import { Model, SchedulingInputJson, makeInitialModel, makeInvalidInputModel } from "./model";
import "./styles.css";
import { makeUpdate } from "./update";
import { view } from "./view";

export interface SchedulingRuntimeInput {
  readonly client: RecruitmentClient;
  readonly serializedInput: string | null;
  readonly commandIdSeed: string;
}

export const embedScheduling = (
  container: HTMLElement,
  input: SchedulingRuntimeInput,
): (() => void) => {
  const commands = makeSchedulingCommands(input.client);
  const update = makeUpdate(commands);
  let initialModel: typeof Model.Type = makeInvalidInputModel();

  if (input.serializedInput !== null) {
    try {
      const decoded = S.decodeUnknownSync(SchedulingInputJson)(input.serializedInput, {
        onExcessProperty: "error",
      });
      initialModel = makeInitialModel(decoded, input.commandIdSeed);
    } catch {
      initialModel = makeInvalidInputModel();
    }
  }

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
          [h.Class("foldkit-scheduling fs-error fs-error--fatal"), h.Role("alert")],
          [
            h.h1([], ["Intervjuplanleggingen kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);
  return () => handle.dispose();
};
