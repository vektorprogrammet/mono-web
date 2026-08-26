import { makeContentWorkspaceCommands } from "./command";
import { FailedCommand } from "./message";
import type { ContentWorkspaceClient } from "./browser-client";
import { Effect } from "effect";
import { Runtime } from "foldkit";
import type { Message } from "./message";
import { Model, makeInitialModel } from "./model";
import "./styles.css";
import { makeUpdate, type WorkspaceCommandFactories } from "./update";
import { view } from "./view";

export interface ContentWorkspaceRuntimeInput {
  readonly client: ContentWorkspaceClient;
}

export const embedContentWorkspace = (
  container: HTMLElement,
  input: ContentWorkspaceRuntimeInput,
): (() => void) => {
  const { LoadWorkspace } = makeContentWorkspaceCommands(input.client);
  const initialModel = makeInitialModel();
  const commandFactories: WorkspaceCommandFactories = {
    LoadWorkspace,
    SubmitCreate: ({ requestId, commandId, title, bodyHtml, departmentIds, sticky }) => ({
      name: "SubmitContentCreate",
      args: { requestId },
      effect: Effect.gen(function* () {
        yield* input.client.admin.content
          .createDraft({ commandId, title, bodyHtml, departmentIds, sticky } as never)
          .pipe(
            Effect.catch(() =>
              Effect.succeed(
                FailedCommand({
                  requestId: requestId,
                  failure: { _tag: "Failed", message: "Lagring feilet. Prøv på nytt." },
                }) as unknown as Message,
              ),
            ),
          );
        return yield* LoadWorkspace({ requestId: requestId }).effect;
      }),
    }),
    SubmitRevise: ({
      requestId,
      commandId,
      articleId,
      expectedRevision,
      title,
      bodyHtml,
      departmentIds,
      sticky,
    }) => ({
      name: "SubmitContentRevise",
      args: { requestId },
      effect: input.client.admin.content
        .reviseDraft({
          commandId,
          articleId,
          expectedRevision,
          title,
          bodyHtml,
          departmentIds,
          sticky,
        } as never)
        .pipe(
          Effect.flatMap(() => LoadWorkspace({ requestId: requestId }).effect),
          Effect.catch(() =>
            Effect.succeed(
              FailedCommand({
                requestId: requestId,
                failure: { _tag: "Failed", message: "Lagring feilet. Prøv på nytt." },
              }) as unknown as Message,
            ),
          ),
        ),
    }),
    SubmitPublish: ({ requestId, commandId, articleId }) => ({
      name: "SubmitContentPublish",
      args: { requestId },
      effect: input.client.admin.content.publish({ commandId, articleId } as never).pipe(
        Effect.flatMap(() => LoadWorkspace({ requestId }).effect),
        Effect.catch(() =>
          Effect.succeed(
            FailedCommand({
              requestId,
              failure: { _tag: "Failed", message: "Lagring feilet. Prøv på nytt." },
            }) as unknown as Message,
          ),
        ),
      ),
    }),
    SubmitUnpublish: ({ requestId, commandId, articleId }) => ({
      name: "SubmitContentUnpublish",
      args: { requestId },
      effect: input.client.admin.content.unpublish({ commandId, articleId } as never).pipe(
        Effect.flatMap(() => LoadWorkspace({ requestId: requestId }).effect),
        Effect.catch(() =>
          Effect.succeed(
            FailedCommand({
              requestId: requestId,
              failure: { _tag: "Failed", message: "Lagring feilet. Prøv på nytt." },
            }) as unknown as Message,
          ),
        ),
      ),
    }),
  };
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
