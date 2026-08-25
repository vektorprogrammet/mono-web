import { Effect } from "effect";
import { Runtime } from "foldkit";
import type { ContentWorkspaceClient } from "./browser-client";
import { makeContentWorkspaceCommands } from "./command";
import { SucceededSave } from "./message";
import { Model, makeInitialModel } from "./model";
import "./styles.css";
import { makeUpdate } from "./update";
import { view } from "./view";
import type { WorkspaceCommandFactories } from "./update";

/**
 * The submit commands are executed server-side by the bridge route; the
 * client-side command objects carry only identity so the runtime can track
 * request identity and stale rejection.
 */
const makeCommandFactories = (load: WorkspaceCommandFactories["LoadWorkspace"]): WorkspaceCommandFactories => ({
  LoadWorkspace: load,
  SubmitCreate: ({ requestId }) => ({
    name: "SubmitContentCreate",
    args: { requestId },
    effect: Effect.succeed(
        SucceededSave({
          requestId: 0,
          workspace: { entries: [] },
        }),
      ) as never,
  }),
  SubmitRevise: ({ requestId }) => ({
    name: "SubmitContentRevise",
    args: { requestId },
    effect: Effect.succeed(
        SucceededSave({
          requestId: 0,
          workspace: { entries: [] },
        }),
      ) as never,
  }),
  SubmitPublish: ({ requestId }) => ({
    name: "SubmitContentPublish",
    args: { requestId },
    effect: Effect.succeed(
        SucceededSave({
          requestId: 0,
          workspace: { entries: [] },
        }),
      ) as never,
  }),
  SubmitUnpublish: ({ requestId }) => ({
    name: "SubmitContentUnpublish",
    args: { requestId },
    effect: Effect.succeed(
        SucceededSave({
          requestId: 0,
          workspace: { entries: [] },
        }),
      ) as never,
  }),
});

export interface ContentWorkspaceRuntimeInput {
  readonly client: ContentWorkspaceClient;
}

export const embedContentWorkspace = (
  container: HTMLElement,
  input: ContentWorkspaceRuntimeInput,
): (() => void) => {
  const load = makeContentWorkspaceCommands(input.client);
  const initialModel = makeInitialModel();
  const commandFactories = makeCommandFactories(load.LoadWorkspace);
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => makeUpdate(commandFactories)(initialModel, { _tag: "RetriedWorkspace" }),
    update: makeUpdate(commandFactories),
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Class("content-workspace content-workspace__error"), h.Role("alert")],
          [
            h.h1([], ["Artikkeladministrasjonen kunne ikke startes"]),
            h.p([], ["Last siden på nytt og prøv igjen."]),
          ],
        ),
    },
  });

  const handle = Runtime.embed(program);
  return () => handle.dispose();
};
