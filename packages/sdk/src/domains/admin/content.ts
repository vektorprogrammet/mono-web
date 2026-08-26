import { Effect, Schema } from "effect";
import type { InternalSdkError } from "../../errors.js";
import { ContentDecodeError } from "../../errors.js";
import {
  ArticleId,
  ContentArticleDetailSchema,
  ContentWorkspaceSchema,
  CreateArticleDraftObservationSchema,
  CreateContentDraftCommandSchema,
  PublicationTransitionCommandSchema,
  PublishObservationSchema,
  ReviseArticleDraftObservationSchema,
  ReviseContentDraftCommandSchema,
  UnpublishObservationSchema,
  type ArticleId as ArticleIdType,
  type ContentArticleDetail,
  type AdminContentWorkspaceInput,
  type CreateArticleDraftObservation,
  type CreateContentDraftCommand,
  type PublicationTransitionCommand,
  type PublishObservation,
  type ReviseArticleDraftObservation,
  type ReviseContentDraftCommand,
  type UnpublishObservation,
} from "../../schemas/content.js";
import type { Transport } from "../../transport.js";

const strictContent = {
  strict: true,
  decodeError: () => new ContentDecodeError(),
  errorFamily: "content",
} as const;

export interface AdminContentDomain {
  /** Reads the caller-visible workspace in exactly one native request. */
  readonly workspace: (
    input?: AdminContentWorkspaceInput,
  ) => Effect.Effect<typeof ContentWorkspaceSchema.Type, InternalSdkError>;
  readonly read: (
    articleId: ArticleIdType,
  ) => Effect.Effect<ContentArticleDetail, InternalSdkError>;
  readonly createDraft: (
    command: CreateContentDraftCommand,
  ) => Effect.Effect<CreateArticleDraftObservation, InternalSdkError>;
  readonly reviseDraft: (
    command: ReviseContentDraftCommand,
  ) => Effect.Effect<ReviseArticleDraftObservation, InternalSdkError>;
  readonly publish: (
    command: PublicationTransitionCommand,
  ) => Effect.Effect<PublishObservation, InternalSdkError>;
  readonly unpublish: (
    command: PublicationTransitionCommand,
  ) => Effect.Effect<UnpublishObservation, InternalSdkError>;
}

export const createAdminContentDomain = (transport: Transport): AdminContentDomain => ({
  workspace: (input = {}) =>
    transport.get(
      "/api/admin/content/workspace",
      ContentWorkspaceSchema,
      input.department === undefined ? undefined : { department: input.department },
      strictContent,
    ),
  read: (articleId) =>
    transport.get(
      `/api/admin/content/articles/${Schema.encodeSync(ArticleId)(articleId)}`,
      ContentArticleDetailSchema,
      undefined,
      strictContent,
    ),
  createDraft: (command) =>
    transport.post(
      "/api/admin/content/articles",
      Schema.encodeSync(CreateContentDraftCommandSchema)(command),
      CreateArticleDraftObservationSchema,
      { ...strictContent, expectedStatus: 201 },
    ),
  reviseDraft: (command) =>
    transport.put(
      `/api/admin/content/articles/${command.articleId}`,
      Schema.encodeSync(ReviseContentDraftCommandSchema)(command),
      ReviseArticleDraftObservationSchema,
      strictContent,
    ),
  publish: (command) =>
    transport.post(
      `/api/admin/content/articles/${command.articleId}/publish`,
      Schema.encodeSync(PublicationTransitionCommandSchema)(command),
      PublishObservationSchema,
      strictContent,
    ),
  unpublish: (command) =>
    transport.post(
      `/api/admin/content/articles/${command.articleId}/unpublish`,
      Schema.encodeSync(PublicationTransitionCommandSchema)(command),
      UnpublishObservationSchema,
      strictContent,
    ),
});
