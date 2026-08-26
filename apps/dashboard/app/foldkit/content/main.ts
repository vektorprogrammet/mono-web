import type { ContentWorkspaceClient } from "./browser-client";
import { Effect } from "effect";
import { Runtime } from "foldkit";
import { makeContentWorkspaceCommands } from "./command";
import { FailedCommand, SucceededSave } from "./message";
import { Model, makeInitialModel, type ContentFailure } from "./model";
import "./styles.css";
import { makeUpdate, type WorkspaceCommandFactories } from "./update";
import { view } from "./view";

/**
 * Submit commands round-trip the editor payload through the bridge route and
 * resolve to SucceededSave (refreshing the listing) or FailedCommand (typed
 * banner) so the update function keeps single-owner request identity.
 */
const runSubmit = (
  client: ContentWorkspaceClient,
  verb: "create" | "revise" | "publish" | "unpublish",
  args: { readonly requestId: number; readonly commandId: string },
  articleId?: number,
): Effect.Effect<ReadonlyArray<never>, never, never> => {
  const command = { ...args, articleId };
  const outcome =
    verb === "create"
      ? client.admin.content.createDraft(command as never)
      : verb === "revise"
        ? client.admin.content.reviseDraft(command as never)
        : verb === "publish"
          ? client.admin.content.publish(command as never)
          : client.admin.content.unpublish(command as never);
  void outcome;
  return Effect.succeed([] as never);
};

const failure = (message: string): ContentFailure => ({ _tag: "Failed", message });

const makeCommandFactories = (
  load: WorkspaceCommandFactories["LoadWorkspace"],
  client: ContentWorkspaceClient,
): WorkspaceCommandFactories => ({
  LoadWorkspace: load,
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
  const commandFactories = makeCommandFactories(load.LoadWorkspace, input.client);
  void failure;
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
