import type { ContentWorkspace } from "@vektorprogrammet/sdk/effect";
import { Match as M } from "effect";
import { Command } from "foldkit";
import type { Message } from "./message";
import type { Model } from "./model";

export interface WorkspaceCommandFactories {
  readonly LoadWorkspace: (args: { readonly requestId: number }) => Command.Command<Message>;
  readonly SubmitCreate: (args: {
    readonly requestId: number;
    readonly commandId: string;
    readonly title: string;
    readonly bodyHtml: string;
    readonly departmentIds: ReadonlyArray<string>;
    readonly sticky: boolean;
  }) => Command.Command<Message>;
  readonly SubmitRevise: (args: {
    readonly requestId: number;
    readonly commandId: string;
    readonly articleId: number;
    readonly expectedRevision: number;
    readonly title: string;
    readonly bodyHtml: string;
    readonly departmentIds: ReadonlyArray<string>;
    readonly sticky: boolean;
  }) => Command.Command<Message>;
  readonly SubmitPublish: (args: {
    readonly requestId: number;
    readonly commandId: string;
    readonly articleId: number;
  }) => Command.Command<Message>;
  readonly SubmitUnpublish: (args: {
    readonly requestId: number;
    readonly commandId: string;
    readonly articleId: number;
  }) => Command.Command<Message>;
}

type UpdateResult = readonly [Model, ReadonlyArray<Command.Command<Message>>];

/** Client-side narrowing of the visible rows; it never issues a request. */
export const visibleEntries = (model: Model): ContentWorkspace["entries"] => {
  if (model.workspace._tag !== "Success") return [];
  const entries = model.workspace.data.entries;
  const filter = model.departmentFilter;
  return filter === null
    ? entries
    : entries.filter((entry) => entry.departmentIds.includes(filter));
};

export const makeUpdate =
  (commands: WorkspaceCommandFactories) =>
  (model: Model, message: Message): UpdateResult =>
    M.value(message).pipe(
      M.withReturnType<UpdateResult>(),
      M.tagsExhaustive({
        LoadedWorkspace: ({ requestId, workspace }) => {
          // Stale-result rejection: a mismatched requestId leaves the Model unchanged.
          if (requestId !== model.requestId) return [model, []];
          return [{ ...model, workspace: { _tag: "Success", data: workspace } }, []];
        },
        FailedWorkspace: ({ requestId, failure }) => {
          if (requestId !== model.requestId) return [model, []];
          return [
            { ...model, workspace: { _tag: "Failure", error: failure }, banner: failure },
            [],
          ];
        },
        RetriedWorkspace: () => {
          // A retry creates a new request id.
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              workspace: { _tag: "Loading" },
              requestId,
              retryCount: model.retryCount + 1,
              banner: null,
            },
            [commands.LoadWorkspace({ requestId })],
          ];
        },
        SelectedArticle: ({ articleId }) => {
          // Load detail into the editor pane; clear stale banners.
          if (model.workspace._tag !== "Success") return [model, []];
          const entry = model.workspace.data.entries.find(
            (candidate) => candidate.articleId === articleId,
          );
          if (entry === undefined) return [model, []];
          return [
            {
              ...model,
              selectedArticleId: articleId,
              selectedRevision: null,
              editor: {
                title: entry.title,
                bodyHtml: "",
                departmentIds: [...entry.departmentIds],
                sticky: entry.sticky,
              },
              dirty: false,
              banner: null,
            },
            [],
          ];
        },
        EditedField: ({ title, bodyHtml, sticky }) => [
          {
            // Mark dirty; validate locally; send nothing.
            ...model,
            editor: {
              ...model.editor,
              ...(title === null ? {} : { title }),
              ...(bodyHtml === null ? {} : { bodyHtml }),
              ...(sticky === null ? {} : { sticky }),
            },
            dirty: true,
          },
          [],
        ],
        ChangedDepartmentSelection: ({ departmentId, checked }) => {
          const current = model.editor.departmentIds;
          const next = checked
            ? current.includes(departmentId)
              ? current
              : [...current, departmentId].sort()
            : current.filter((id) => id !== departmentId);
          if (next === current) return [model, []];
          return [{ ...model, editor: { ...model.editor, departmentIds: next }, dirty: true }, []];
        },
        SubmittedCreate: ({ commandId }) => {
          if (!model.dirty || model.selectedArticleId !== null) return [model, []];
          const requestId = model.requestId + 1;
          return [
            { ...model, requestId, dirty: false },
            [
              commands.SubmitCreate({
                requestId,
                commandId,
                title: model.editor.title,
                bodyHtml: model.editor.bodyHtml,
                departmentIds: model.editor.departmentIds,
                sticky: model.editor.sticky,
              }),
            ],
          ];
        },
        SubmittedRevise: ({ commandId }) => {
          if (!model.dirty) return [model, []];
          const entry =
            model.workspace._tag === "Success" && model.selectedArticleId !== null
              ? model.workspace.data.entries.find(
                  (candidate) => candidate.articleId === model.selectedArticleId,
                )
              : undefined;
          if (entry === undefined || !entry.canRevise) return [model, []];
          const requestId = model.requestId + 1;
          return [
            { ...model, requestId, dirty: false },
            [
              commands.SubmitRevise({
                requestId,
                commandId,
                articleId: entry.articleId,
                expectedRevision: model.selectedRevision ?? 0,
                title: model.editor.title,
                bodyHtml: model.editor.bodyHtml,
                departmentIds: model.editor.departmentIds,
                sticky: model.editor.sticky,
              }),
            ],
          ];
        },
        SucceededSave: ({ requestId, workspace }) => {
          // A stale success leaves the Model unchanged.
          if (requestId !== model.requestId) return [model, []];
          return [{ ...model, workspace: { _tag: "Success", data: workspace } }, []];
        },
        FailedCommand: ({ requestId, failure }) => {
          // Show the typed safe failure; preserve selections. Stale failures
          // leave the Model unchanged.
          if (requestId !== model.requestId) return [model, []];
          return [{ ...model, banner: failure }, []];
        },
        SubmittedPublish: ({ commandId }) => {
          // Publisher capability must already hold in the Model.
          if (model.workspace._tag !== "Success" || model.selectedArticleId === null)
            return [model, []];
          const entry = model.workspace.data.entries.find(
            (candidate) => candidate.articleId === model.selectedArticleId,
          );
          if (entry === undefined || !entry.canPublish) return [model, []];
          const requestId = model.requestId + 1;
          return [
            { ...model, requestId },
            [commands.SubmitPublish({ requestId, commandId, articleId: entry.articleId })],
          ];
        },
        SubmittedUnpublish: ({ commandId }) => {
          if (model.workspace._tag !== "Success" || model.selectedArticleId === null)
            return [model, []];
          const entry = model.workspace.data.entries.find(
            (candidate) => candidate.articleId === model.selectedArticleId,
          );
          if (entry === undefined || !entry.canPublish) return [model, []];
          const requestId = model.requestId + 1;
          return [
            { ...model, requestId },
            [commands.SubmitUnpublish({ requestId, commandId, articleId: entry.articleId })],
          ];
        },
        ChangedDepartmentFilter: ({ departmentId }) => [
          // Narrow the visible rows; no new server request.
          { ...model, departmentFilter: departmentId },
          [],
        ],
        DismissedBanner: () => [{ ...model, banner: null }, []],
      }),
    );
