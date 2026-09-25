import type { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Runtime } from "foldkit";
import type { TeamApplicationsOperations } from "./browser-client";
import { commandsFor } from "./command";
import { init, Model, type TeamId } from "./model";
import "./styles.css";
import { updateFor } from "./update";
import { view } from "./view";

export interface TeamApplicationsRuntimeInput {
  readonly teamId: TeamId;
  readonly idempotencyKeySeed: IdempotencyKey;
  readonly client: TeamApplicationsOperations;
}

export const embedTeamApplications = (
  container: HTMLElement,
  input: TeamApplicationsRuntimeInput,
): (() => void) => {
  const commands = commandsFor(input.client);
  const initialModel = init(input.teamId, input.idempotencyKeySeed);

  const program = Runtime.makeElement({
    Model,
    container,
    init: () => ({
      model: initialModel,
      commands: [
        commands.LoadPage({
          teamId: initialModel.teamId,
          cursor: initialModel.pageCursor,
          requestId: initialModel.pageRequestId,
        }),
      ],
    }),
    update: updateFor(commands),
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Class("team-applications"), h.Role("alert")],
          [
            h.h1([], ["Team-søknadene kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);

  return () => handle.dispose();
};
