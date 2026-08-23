import { Schema as S } from "effect";
import { Runtime } from "foldkit";
import { DashboardInputJson, Model, makeInitialModel, makeInvalidInputModel } from "./model";
import "./styles.css";
import { update } from "./update";
import { view } from "./view";

const initialModelFrom = (serializedInput: string | null): Model => {
  if (serializedInput === null) return makeInvalidInputModel();

  try {
    return makeInitialModel(
      S.decodeUnknownSync(DashboardInputJson)(serializedInput, {
        onExcessProperty: "error",
      }),
    );
  } catch {
    return makeInvalidInputModel();
  }
};

export const embedDashboard = (
  container: HTMLElement,
  serializedInput: string | null,
): (() => void) => {
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => [initialModelFrom(serializedInput), []],
    update,
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.main(
          [h.Class("foldkit-dashboard fd-startup-error"), h.Role("alert")],
          [
            h.section(
              [h.Class("fd-error-card")],
              [
                h.h1([], ["Kontrollpanelet kunne ikke startes"]),
                h.p([], ["Last siden på nytt og prøv igjen."]),
              ],
            ),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);
  return () => handle.dispose();
};
