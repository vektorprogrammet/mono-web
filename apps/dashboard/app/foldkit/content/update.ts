import type { ArticleId, ContentWorkspace } from "@vektorprogrammet/domain/content";
import type { DepartmentId } from "@vektorprogrammet/domain/organization";
import type { StrongETag } from "@vektorprogrammet/http-api";
import { Match as M } from "effect";
import { Command } from "foldkit";
import type { Message } from "./message";
import { makeEditorValues, type Model } from "./model";

export interface WorkspaceCommandFactories {
  readonly LoadWorkspace: (args: { readonly requestId: number }) => Command.Command<Message>;
  readonly LoadArticleDetail: (args: {
    readonly requestId: number;
    readonly articleId: ArticleId;
  }) => Command.Command<Message>;
  readonly SubmitCreate: (args: {
    readonly requestId: number;
    readonly commandId: string;
    readonly title: string;
    readonly bodyHtml: string;
    readonly departmentIds: ReadonlyArray<DepartmentId>;
    readonly sticky: boolean;
  }) => Command.Command<Message>;
  readonly SubmitRevise: (args: {
    readonly requestId: number;
    readonly commandId: string;
    readonly articleId: ArticleId;
    readonly expectedEtag: StrongETag;
    readonly title: string;
    readonly bodyHtml: string;
    readonly departmentIds: ReadonlyArray<DepartmentId>;
    readonly sticky: boolean;
  }) => Command.Command<Message>;
  readonly SubmitPublish: (args: {
    readonly requestId: number;
    readonly commandId: string;
    readonly articleId: ArticleId;
  }) => Command.Command<Message>;
  readonly SubmitUnpublish: (args: {
    readonly requestId: number;
    readonly commandId: string;
    readonly articleId: ArticleId;
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
        LoadedWorkspace: ({ requestId, workspace, knownDepartments }) => {
          // Stale-result rejection: a mismatched requestId leaves the Model unchanged.
          if (requestId !== model.requestId) return [model, []];
          return [
            {
              ...model,
              workspace: { _tag: "Success", data: workspace },
              knownDepartments: [...knownDepartments],
            },
            [],
          ];
        },
        LoadedArticleDetail: ({ requestId, observation }) => {
          const { body: detail, etag } = observation;
          if (
            requestId !== model.requestId ||
            model.selectedArticleId !== detail.articleId ||
            model.pendingCommand !== "Detail"
          ) {
            return [model, []];
          }
          return [
            {
              ...model,
              selectedEtag: etag,
              editor: {
                title: detail.title,
                bodyHtml: detail.bodyHtml,
                departmentIds: [...detail.departmentIds],
                sticky: detail.sticky,
              },
              dirty: false,
              pendingCommand: null,
              banner: null,
            },
            [],
          ];
        },
        FailedWorkspace: ({ requestId, failure }) => {
          if (requestId !== model.requestId) return [model, []];
          return [
            { ...model, workspace: { _tag: "Failure", error: failure }, banner: failure },
            [],
          ];
        },
        RetriedWorkspace: () => {
          if (model.pendingCommand !== null) return [model, []];
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
          if (model.workspace._tag !== "Success" || model.pendingCommand !== null) {
            return [model, []];
          }
          const entry = model.workspace.data.entries.find(
            (candidate) => candidate.articleId === articleId,
          );
          if (entry === undefined) return [model, []];
          if (!entry.canRevise) return [model, []];
          if (model.selectedArticleId === articleId && model.selectedEtag !== null) {
            return [{ ...model, banner: null }, []];
          }
          const requestId = model.requestId + 1;
          const changedSelection = model.selectedArticleId !== articleId;
          return [
            {
              ...model,
              requestId,
              selectedArticleId: articleId,
              selectedEtag: null,
              editor: changedSelection ? makeEditorValues() : model.editor,
              dirty: changedSelection ? false : model.dirty,
              pendingCommand: "Detail",
              banner: null,
            },
            [commands.LoadArticleDetail({ requestId, articleId })],
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
          if (!model.dirty || model.selectedArticleId !== null || model.pendingCommand !== null) {
            return [model, []];
          }
          const requestId = model.requestId + 1;
          return [
            { ...model, requestId, pendingCommand: "Create", banner: null },
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
          if (!model.dirty || model.selectedEtag === null || model.pendingCommand !== null) {
            return [model, []];
          }
          const entry =
            model.workspace._tag === "Success" && model.selectedArticleId !== null
              ? model.workspace.data.entries.find(
                  (candidate) => candidate.articleId === model.selectedArticleId,
                )
              : undefined;
          if (entry === undefined || !entry.canRevise) return [model, []];
          const requestId = model.requestId + 1;
          return [
            { ...model, requestId, pendingCommand: "Revise", banner: null },
            [
              commands.SubmitRevise({
                requestId,
                commandId,
                articleId: entry.articleId,
                expectedEtag: model.selectedEtag,
                title: model.editor.title,
                bodyHtml: model.editor.bodyHtml,
                departmentIds: model.editor.departmentIds,
                sticky: model.editor.sticky,
              }),
            ],
          ];
        },
        SucceededSave: ({ requestId, observation }) => {
          // A stale success leaves the Model unchanged.
          if (requestId !== model.requestId) return [model, []];
          const { body: draft, etag } = observation;
          const workspace =
            model.workspace._tag === "Success"
              ? {
                  _tag: "Success" as const,
                  data: {
                    entries: model.workspace.data.entries.map((entry) =>
                      entry.articleId === draft.articleId
                        ? {
                            ...entry,
                            title: draft.title,
                            slug: draft.slug,
                            status:
                              draft.currentVersionNumber === null
                                ? ("Draft" as const)
                                : ("Published" as const),
                            sticky: draft.sticky,
                            updatedAt: draft.updatedAt,
                          }
                        : entry,
                    ),
                  },
                }
              : model.workspace;
          return [
            {
              ...model,
              workspace,
              selectedArticleId: draft.articleId,
              selectedEtag: etag,
              editor: {
                title: draft.title,
                bodyHtml: draft.bodyHtml,
                departmentIds: [...draft.departmentIds],
                sticky: draft.sticky,
              },
              dirty: false,
              pendingCommand: null,
              banner: null,
            },
            [commands.LoadWorkspace({ requestId })],
          ];
        },
        SucceededTransition: ({ requestId }) => {
          if (requestId !== model.requestId) return [model, []];
          return [
            { ...model, selectedEtag: null, pendingCommand: null, banner: null },
            [commands.LoadWorkspace({ requestId })],
          ];
        },
        FailedCommand: ({ requestId, failure }) => {
          // Show the typed safe failure; preserve selection, editor, and dirty state.
          if (requestId !== model.requestId) return [model, []];
          return [
            {
              ...model,
              selectedEtag: failure.tag === "CommandConflict" ? null : model.selectedEtag,
              pendingCommand: null,
              banner: failure,
            },
            [],
          ];
        },
        SubmittedPublish: ({ commandId, articleId }) => {
          if (model.workspace._tag !== "Success" || model.pendingCommand !== null) {
            return [model, []];
          }
          const entry = model.workspace.data.entries.find(
            (candidate) => candidate.articleId === articleId,
          );
          if (entry === undefined || !entry.canPublish) return [model, []];
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              requestId,
              selectedArticleId: articleId,
              pendingCommand: "Publish",
              banner: null,
            },
            [commands.SubmitPublish({ requestId, commandId, articleId })],
          ];
        },
        SubmittedUnpublish: ({ commandId, articleId }) => {
          if (model.workspace._tag !== "Success" || model.pendingCommand !== null) {
            return [model, []];
          }
          const entry = model.workspace.data.entries.find(
            (candidate) => candidate.articleId === articleId,
          );
          if (entry === undefined || !entry.canPublish) return [model, []];
          const requestId = model.requestId + 1;
          return [
            {
              ...model,
              requestId,
              selectedArticleId: articleId,
              pendingCommand: "Unpublish",
              banner: null,
            },
            [commands.SubmitUnpublish({ requestId, commandId, articleId })],
          ];
        },
        ChangedDepartmentFilter: ({ departmentId }) => [
          // Narrow the visible rows; no new server request.
          { ...model, departmentFilter: departmentId },
          [],
        ],
        DeselectedArticle: () => {
          if (model.pendingCommand !== null) return [model, []];
          return [
            {
              ...model,
              selectedArticleId: null,
              selectedEtag: null,
              editor: makeEditorValues(),
              dirty: false,
              banner: null,
            },
            [],
          ];
        },
        DismissedBanner: () => [{ ...model, banner: null }, []],
      }),
    );
