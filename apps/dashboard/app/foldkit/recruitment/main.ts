import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { Runtime } from "foldkit";
import type { RecruitmentClient } from "./browser-client";
import { makeRecruitmentCommands } from "./command";
import { Model, RecruitmentInputJson, makeInitialModel, makeInvalidInputModel } from "./model";
import "./styles.css";
import { makeUpdate } from "./update";
import { view } from "./view";

export interface RecruitmentRuntimeInput {
  readonly client: RecruitmentClient;
  readonly serializedInput: string | null;
  readonly idempotencyKeySeed: typeof IdempotencyKey.Type;
}

export const embedRecruitment = (
  container: HTMLElement,
  input: RecruitmentRuntimeInput,
): (() => void) => {
  const commands = makeRecruitmentCommands(input.client);
  const update = makeUpdate(commands);
  let initialModel: typeof Model.Type = makeInvalidInputModel();

  if (input.serializedInput !== null) {
    try {
      const decoded = S.decodeUnknownSync(RecruitmentInputJson)(input.serializedInput, {
        onExcessProperty: "error",
      });
      initialModel = makeInitialModel(decoded, input.idempotencyKeySeed);
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
          [h.Class("foldkit-recruitment fr-error fr-error--fatal"), h.Role("alert")],
          [
            h.h1([], ["Søkeroversikten kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);
  return () => handle.dispose();
};
