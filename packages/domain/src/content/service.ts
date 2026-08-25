import { Context, Effect } from "effect";
import type { ContentManagementFailure } from "./errors.js";
import type {
  ArticleId,
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
  readonly readWorkspace: (
    context: ContentManagementContext,
    query: ContentWorkspaceQuery,
  ) => Effect.Effect<ContentWorkspace, ContentManagementFailure>;
  readonly createDraft: (
    command: CreateArticleDraftInput,
    context: ContentManagementContext,
  ) => Effect.Effect<
    { readonly _tag: "DraftCreated"; readonly articleId: ArticleId; readonly slug: string },
    ContentCommandFailure
  >;
  readonly reviseDraft: (
    command: ReviseArticleDraftInput,
    context: ContentManagementContext,
  ) => Effect.Effect<
    {
      readonly _tag: "DraftRevised";
      readonly commandId: string;
      readonly articleId: number;
      readonly revision: number;
    },
    ContentCommandFailure
  >;
  readonly publish: (
    command: PublishArticleInput,
    context: ContentManagementContext,
  ) => Effect.Effect<PublishObservation, ContentCommandFailure>;
  readonly unpublish: (
    command: UnpublishArticleInput,
    context: ContentManagementContext,
  ) => Effect.Effect<UnpublishObservation, ContentCommandFailure>;
}

export class ContentManagement extends Context.Service<ContentManagement, ContentManagementShape>()(
  "@vektorprogrammet/domain/ContentManagement",
) {}
