import { Runtime } from "foldkit";
import type { ContentWorkspaceClient } from "./browser-client";
import { makeContentWorkspaceCommands } from "./command";
import { Model, makeInitialModel } from "./model";
import "./styles.css";
import { makeUpdate } from "./update";

export interface ContentWorkspaceRuntimeInput {
  readonly client: ContentWorkspaceClient;
}

export const embedContentWorkspace = (
  container: HTMLElement,
  input: ContentWorkspaceRuntimeInput,
): (() => void) => {
  const load = makeContentWorkspaceCommands(input.client);
  const initialModel = makeInitialModel();
  const program = Runtime.makeElement({
    Model,
    container,
    init: () => {
      const [model, emitted] = makeUpdate({
        LoadWorkspace: load.LoadWorkspace,
        SubmitCreate: ({ requestId }) => ({
          name: "SubmitContentCreate",
          args: { requestId },
          effect: undefined as never,
        }),
        SubmitRevise: ({ requestId }) => ({
          name: "SubmitContentRevise",
          args: { requestId },
          effect: undefined as never,
        }),
        SubmitPublish: ({ requestId }) => ({
          name: "SubmitContentPublish",
          args: { requestId },
          effect: undefined as never,
        }),
        SubmitUnpublish: ({ requestId }) => ({
          name: "SubmitContentUnpublish",
          args: { requestId },
          effect: undefined as never,
        }),
      })(initialModel, { _tag: "RetriedWorkspace" });
      void emitted;
      return [model, []];
    },
    update: makeUpdate({
      LoadWorkspace: load.LoadWorkspace,
      SubmitCreate: ({ requestId }) => ({
        name: "SubmitContentCreate",
        args: { requestId },
        effect: undefined as never,
      }),
      SubmitRevise: ({ requestId }) => ({
        name: "SubmitContentRevise",
        args: { requestId },
        effect: undefined as never,
      }),
      SubmitPublish: ({ requestId }) => ({
        name: "SubmitContentPublish",
        args: { requestId },
        effect: undefined as never,
      }),
      SubmitUnpublish: ({ requestId }) => ({
        name: "SubmitContentUnpublish",
        args: { requestId },
        effect: undefined as never,
      }),
    }),
    view: (_model) =>
      // Placeholder view; the full view lands with the accessibility pass.
      ({ tag: "section", children: [] }) as never,
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
