import { ArticleId, ContentWorkspaceSchema } from "@vektorprogrammet/domain/content";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { Schema as S } from "effect";
import { m } from "foldkit/message";
import { ContentArticleObservationSchema } from "./bridge";
import { ContentFailure, ContentRequestId, KnownDepartmentSchema } from "./model";

export const LoadedWorkspace = m("LoadedWorkspace", {
  requestId: ContentRequestId,
  workspace: ContentWorkspaceSchema,
  knownDepartments: S.Array(KnownDepartmentSchema),
});
export const FailedWorkspace = m("FailedWorkspace", {
  requestId: ContentRequestId,
  failure: ContentFailure,
});
export const LoadedArticleDetail = m("LoadedArticleDetail", {
  requestId: ContentRequestId,
  observation: ContentArticleObservationSchema,
});
export const RetriedWorkspace = m("RetriedWorkspace");

export const SelectedArticle = m("SelectedArticle", { articleId: ArticleId });
export const EditedField = m("EditedField", {
  title: S.NullOr(S.String),
  bodyHtml: S.NullOr(S.String),
  sticky: S.NullOr(S.Boolean),
});
export const ChangedDepartmentSelection = m("ChangedDepartmentSelection", {
  departmentId: DepartmentId,
  checked: S.Boolean,
});

export const SubmittedCreate = m("SubmittedCreate", { commandId: S.String });
export const SubmittedRevise = m("SubmittedRevise", { commandId: S.String });
export const SucceededSave = m("SucceededSave", {
  requestId: ContentRequestId,
  observation: ContentArticleObservationSchema,
});
export const SucceededTransition = m("SucceededTransition", {
  requestId: ContentRequestId,
});
export const FailedCommand = m("FailedCommand", {
  requestId: ContentRequestId,
  failure: ContentFailure,
});

/** Publisher capability is required in the Model before these issue a command. */
export const SubmittedPublish = m("SubmittedPublish", {
  commandId: S.String,
  articleId: ArticleId,
});
export const SubmittedUnpublish = m("SubmittedUnpublish", {
  commandId: S.String,
  articleId: ArticleId,
});

/** Client-side narrowing only; never triggers a server request. */
export const ChangedDepartmentFilter = m("ChangedDepartmentFilter", {
  departmentId: S.NullOr(DepartmentId),
});

export const DismissedBanner = m("DismissedBanner");
/** Clears the selection so the editor becomes a fresh-draft form. */
export const DeselectedArticle = m("DeselectedArticle");

export const Message = S.Union([
  LoadedWorkspace,
  LoadedArticleDetail,
  FailedWorkspace,
  RetriedWorkspace,
  SelectedArticle,
  EditedField,
  ChangedDepartmentSelection,
  SubmittedCreate,
  SubmittedRevise,
  SucceededSave,
  FailedCommand,
  SucceededTransition,
  SubmittedPublish,
  SubmittedUnpublish,
  ChangedDepartmentFilter,
  DeselectedArticle,
  DismissedBanner,
]);
export type Message = S.Schema.Type<typeof Message>;
