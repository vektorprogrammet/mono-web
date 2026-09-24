import { ArticleId, ContentWorkspaceSchema } from "@vektorprogrammet/http-api"
import { DepartmentId } from "@vektorprogrammet/http-api"
import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import { ContentArticleObservationSchema } from "./bridge";
import { ContentFailure, ContentRequestId, KnownDepartmentSchema } from "./model";

export const LoadedWorkspace = taggedStruct("LoadedWorkspace", {
  requestId: ContentRequestId,
  workspace: ContentWorkspaceSchema,
  knownDepartments: S.Array(KnownDepartmentSchema),
});

export const FailedWorkspace = taggedStruct("FailedWorkspace", {
  requestId: ContentRequestId,
  failure: ContentFailure,
});

export const LoadedArticleDetail = taggedStruct("LoadedArticleDetail", {
  requestId: ContentRequestId,
  observation: ContentArticleObservationSchema,
});

export const RetriedWorkspace = taggedStruct("RetriedWorkspace", {});

export const SelectedArticle = taggedStruct("SelectedArticle", { articleId: ArticleId });

export const EditedField = taggedStruct("EditedField", {
  title: S.NullOr(S.String),
  bodyHtml: S.NullOr(S.String),
  sticky: S.NullOr(S.Boolean),
});

export const ChangedDepartmentSelection = taggedStruct("ChangedDepartmentSelection", {
  departmentId: DepartmentId,
  checked: S.Boolean,
});

export const SubmittedCreate = taggedStruct("SubmittedCreate", { commandId: S.String });

export const SubmittedRevise = taggedStruct("SubmittedRevise", { commandId: S.String });

export const SucceededSave = taggedStruct("SucceededSave", {
  requestId: ContentRequestId,
  observation: ContentArticleObservationSchema,
});

export const SucceededTransition = taggedStruct("SucceededTransition", {
  requestId: ContentRequestId,
});

export const FailedCommand = taggedStruct("FailedCommand", {
  requestId: ContentRequestId,
  failure: ContentFailure,
});

/** Publisher capability is required in the Model before these issue a command. */
export const SubmittedPublish = taggedStruct("SubmittedPublish", {
  commandId: S.String,
  articleId: ArticleId,
});

export const SubmittedUnpublish = taggedStruct("SubmittedUnpublish", {
  commandId: S.String,
  articleId: ArticleId,
});

/** Client-side narrowing only; never triggers a server request. */
export const ChangedDepartmentFilter = taggedStruct("ChangedDepartmentFilter", {
  departmentId: S.NullOr(DepartmentId),
});

export const DismissedBanner = taggedStruct("DismissedBanner", {});

/** Clears the selection so the editor becomes a fresh-draft form. */
export const DeselectedArticle = taggedStruct("DeselectedArticle", {});

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
