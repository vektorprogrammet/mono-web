import { Effect } from "effect";
import { Database } from "../database/service.js";
import type { OrganizationAuthorityInstant } from "../organization/authority.js";
import type { PersonId } from "../organization/schema.js";
import { Organization } from "../organization/service.js";
import { Profile } from "../profile/service.js";
import { Content } from "./content-service.js";
import type {
  ArticleId,
  ContentWorkspaceQuery,
  CreateArticleDraftInput,
  PublishArticleInput,
  ReviseArticleDraftInput,
  UnpublishArticleInput,
} from "./schema.js";
import { ContentManagement } from "./service.js";

export const runContentWorkspace = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  query: ContentWorkspaceQuery,
) =>
  Effect.gen(function* () {
    yield* Database;
    yield* Organization;
    yield* Profile;
    const content = yield* ContentManagement;
    return yield* content.readWorkspace({ personId, authorizationInstant }, query);
  });
export const runContentArticleDetail = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  articleId: ArticleId,
) =>
  Effect.gen(function* () {
    yield* Database;
    yield* Organization;
    yield* Profile;
    const content = yield* ContentManagement;
    return yield* content.readArticleDetail(articleId, { personId, authorizationInstant });
  });

export type ContentManagementCommand =
  | { readonly _tag: "CreateDraft"; readonly command: CreateArticleDraftInput }
  | { readonly _tag: "ReviseDraft"; readonly command: ReviseArticleDraftInput }
  | { readonly _tag: "Publish"; readonly command: PublishArticleInput }
  | { readonly _tag: "Unpublish"; readonly command: UnpublishArticleInput };

export const runPublicationTransition = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  input: ContentManagementCommand,
) =>
  Effect.gen(function* () {
    yield* Database;
    yield* Organization;
    const content = yield* ContentManagement;
    const context = { personId, authorizationInstant };
    switch (input._tag) {
      case "CreateDraft":
        return yield* content.createDraft(input.command, context);
      case "ReviseDraft":
        return yield* content.reviseDraft(input.command, context);
      case "Publish":
        return yield* content.publish(input.command, context);
      case "Unpublish":
        return yield* content.unpublish(input.command, context);
    }
  });

export type PublicNewsRead =
  | {
      readonly _tag: "Listing";
      readonly departmentId?: ContentWorkspaceQuery["departmentId"];
    }
  | { readonly _tag: "Article"; readonly slug: string; readonly versionNumber?: number };

export const readPublicNews = (input: PublicNewsRead) =>
  Effect.gen(function* () {
    yield* Database;
    yield* Organization;
    yield* Profile;
    const content = yield* Content;
    return input._tag === "Listing"
      ? yield* content.readNewsListing(input.departmentId)
      : yield* content.readPublishedArticle(input.slug, input.versionNumber);
  });
