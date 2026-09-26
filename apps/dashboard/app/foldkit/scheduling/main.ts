import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { Runtime } from "foldkit";
import type { RecruitmentClient } from "../recruitment/browser-client";
import { commandsFor } from "./command";
import { Model, SchedulingInputJson, init, invalidInputModel } from "./model";
import "./styles.css";
import { updateFor } from "./update";
import { view } from "./view";

export interface SchedulingRuntimeInput {
  readonly client: RecruitmentClient;
  readonly serializedInput: string | null;
  readonly idempotencyKeySeed: IdempotencyKey;
}

export const embedScheduling = (
  container: HTMLElement,
  input: SchedulingRuntimeInput,
): (() => void) => {
  const commands = commandsFor(input.client);
  const update = updateFor(commands);
  let initialModel: Model = invalidInputModel();

  if (input.serializedInput !== null) {
    try {
      const decoded = S.decodeSync(SchedulingInputJson)(input.serializedInput, {
        onExcessProperty: "error",
      });

      initialModel = init(decoded, input.idempotencyKeySeed);
    } catch {
      initialModel = invalidInputModel();
    }
  }

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
