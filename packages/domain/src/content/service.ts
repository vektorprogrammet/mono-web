import { Context, Effect } from "effect";
import type { ContentManagementFailure } from "./errors.js";
import type {
  ArticleId,
  ArticleDraftJson,
  ContentArticleDetail,
  ContentWorkspace,
  ContentWorkspaceQuery,
  CreateArticleDraftInput,
  PublishArticleInput,
  PublishObservation,
  ReviseArticleDraftInput,
  UnpublishArticleInput,
  UnpublishObservation,
} from "./schema.js";
import type { PersonId } from "../organization/schema.js";
import type { OrganizationAuthorityInstant } from "../organization/authority.js";
import type { Organization } from "../organization/service.js";
import type { Profile } from "../profile/service.js";

export interface ContentManagementContext {
  readonly personId: PersonId;
  readonly authorizationInstant: OrganizationAuthorityInstant;
}

/**
 * Every staff operation fails with the full management failure union: the
 * interpreters resolve authority inside their own transactions, so even a
 * create can deny.
 */
export type ContentCommandFailure = ContentManagementFailure;

export interface ContentManagementShape {
  readonly readArticleDetail: (
    articleId: ArticleId,
    context: ContentManagementContext,
  ) => Effect.Effect<ContentArticleDetail, ContentManagementFailure, Organization | Profile>;
  readonly readWorkspace: (
    context: ContentManagementContext,
    query: ContentWorkspaceQuery,
  ) => Effect.Effect<ContentWorkspace, ContentManagementFailure, Organization | Profile>;
  readonly createDraft: (
    command: CreateArticleDraftInput,
    context: ContentManagementContext,
  ) => Effect.Effect<ArticleDraftJson, ContentCommandFailure, Organization>;
  readonly reviseDraft: (
    command: ReviseArticleDraftInput,
    context: ContentManagementContext,
  ) => Effect.Effect<ArticleDraftJson, ContentCommandFailure, Organization>;
  readonly publish: (
    command: PublishArticleInput,
    context: ContentManagementContext,
  ) => Effect.Effect<PublishObservation, ContentCommandFailure, Organization>;
  readonly unpublish: (
    command: UnpublishArticleInput,
    context: ContentManagementContext,
  ) => Effect.Effect<UnpublishObservation, ContentCommandFailure, Organization>;
}

export class ContentManagement extends Context.Service<ContentManagement, ContentManagementShape>()(
  "@vektorprogrammet/domain/ContentManagement",
) {}
