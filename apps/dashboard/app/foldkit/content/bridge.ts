import { ArticleId, ContentArticleDetailSchema, ContentWorkspaceSchema } from "@vektorprogrammet/domain/content";
import { ArticleMergePatch, CreateArticleRequest, IdempotencyKey, StrongETag } from "@vektorprogrammet/http-api";
import { Schema as S } from "effect";
import { KnownDepartmentSchema } from "./model";

export const ContentBridgeErrorTagSchema = S.Literals([
  "UnauthenticatedActor",
  "AuthorityInactive",
  "NotInScope",
  "NotPublisher",
  "DraftNotOwned",
  "SlugConflict",
  "CommandConflict",
  "ArticleNotFound",
  "ContentDecodeError",
  "ContentIntegrityError",
  "ContentPersistenceError",
  "DepartmentNotFound",
  "Network",
  "Configuration",
]);
export type ContentBridgeErrorTag = typeof ContentBridgeErrorTagSchema.Type;

export const ContentBridgeFailureSchema = S.Struct({
  error: S.Struct({ tag: ContentBridgeErrorTagSchema }),
});
export type ContentBridgeFailure = typeof ContentBridgeFailureSchema.Type;

export const ContentWorkspaceBootstrapSchema = S.Struct({
  workspace: ContentWorkspaceSchema,
  knownDepartments: S.Array(KnownDepartmentSchema),
});
export type ContentWorkspaceBootstrap = typeof ContentWorkspaceBootstrapSchema.Type;

export const ContentArticleObservationSchema = S.Struct({
  body: ContentArticleDetailSchema,
  etag: StrongETag,
});
export type ContentArticleObservation = typeof ContentArticleObservationSchema.Type;

export const ContentCreateCommandSchema = S.Struct({
  commandId: IdempotencyKey,
  ...CreateArticleRequest.fields,
});
export type ContentCreateCommand = typeof ContentCreateCommandSchema.Type;

export const ContentReviseCommandSchema = S.Struct({
  commandId: IdempotencyKey,
  articleId: ArticleId,
  etag: StrongETag,
  ...ArticleMergePatch.fields,
});
export type ContentReviseCommand = typeof ContentReviseCommandSchema.Type;

export const ContentTransitionCommandSchema = S.Struct({
  commandId: IdempotencyKey,
  articleId: ArticleId,
});
export type ContentTransitionCommand = typeof ContentTransitionCommandSchema.Type;

export const contentBridgeFailure = (tag: ContentBridgeErrorTag): ContentBridgeFailure => ({
  error: { tag },
});
