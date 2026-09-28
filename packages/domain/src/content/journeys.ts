import { Data, Match, Predicate, Effect } from "effect";
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
import { dual } from "effect/Function";

const runContentWorkspaceImpl = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  query: ContentWorkspaceQuery,
) =>
  Effect.gen(function* () {
    yield* Organization;
    yield* Profile;
    const content = yield* ContentManagement;

    return yield* content.readWorkspace({ personId, authorizationInstant }, query);
  });

export const runContentWorkspace: {
  (
    authorizationInstant: OrganizationAuthorityInstant,
    query: ContentWorkspaceQuery,
  ): (personId: PersonId) => ReturnType<typeof runContentWorkspaceImpl>;
  (
    personId: PersonId,
    authorizationInstant: OrganizationAuthorityInstant,
    query: ContentWorkspaceQuery,
  ): ReturnType<typeof runContentWorkspaceImpl>;
} = dual(3, runContentWorkspaceImpl);

const runContentArticleDetailImpl = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  articleId: ArticleId,
) =>
  Effect.gen(function* () {
    yield* Organization;
    yield* Profile;
    const content = yield* ContentManagement;

    return yield* content.readArticleDetail(articleId, { personId, authorizationInstant });
  });

export const runContentArticleDetail: {
  (
    authorizationInstant: OrganizationAuthorityInstant,
    articleId: ArticleId,
  ): (personId: PersonId) => ReturnType<typeof runContentArticleDetailImpl>;
  (
    personId: PersonId,
    authorizationInstant: OrganizationAuthorityInstant,
    articleId: ArticleId,
  ): ReturnType<typeof runContentArticleDetailImpl>;
} = dual(3, runContentArticleDetailImpl);

export type ContentManagementCommand =
  | { readonly _tag: "CreateDraft"; readonly command: CreateArticleDraftInput }
  | { readonly _tag: "ReviseDraft"; readonly command: ReviseArticleDraftInput }
  | { readonly _tag: "Publish"; readonly command: PublishArticleInput }
  | { readonly _tag: "Unpublish"; readonly command: UnpublishArticleInput };

const runPublicationTransitionImpl = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  input: ContentManagementCommand,
) =>
  Effect.gen(function* () {
    yield* Organization;
    const content = yield* ContentManagement;
    const context = { personId, authorizationInstant };

    return yield* Match.value(input).pipe(
      Match.tag("CreateDraft", (input) => content.createDraft(input.command, context)),
      Match.tag("ReviseDraft", (input) => content.reviseDraft(input.command, context)),
      Match.tag("Publish", (input) => content.publish(input.command, context)),
      Match.tag("Unpublish", (input) => content.unpublish(input.command, context)),
      Match.exhaustive,
    );
  });

export const runPublicationTransition: {
  (
    authorizationInstant: OrganizationAuthorityInstant,
    input: ContentManagementCommand,
  ): (personId: PersonId) => ReturnType<typeof runPublicationTransitionImpl>;
  (
    personId: PersonId,
    authorizationInstant: OrganizationAuthorityInstant,
    input: ContentManagementCommand,
  ): ReturnType<typeof runPublicationTransitionImpl>;
} = dual(3, runPublicationTransitionImpl);

export type PublicNewsRead =
  | {
      readonly _tag: "Listing";
      readonly departmentId?: ContentWorkspaceQuery["departmentId"];
    }
  | { readonly _tag: "Article"; readonly slug: string; readonly versionNumber?: number };

export const PublicNewsRead = Data.taggedEnum<PublicNewsRead>();

export const readPublicNews = (input: PublicNewsRead) =>
  Effect.gen(function* () {
    yield* Organization;
    yield* Profile;
    const content = yield* Content;

    return Predicate.isTagged(input, "Listing")
      ? yield* content.readNewsListing(input.departmentId)
      : yield* content.readPublishedArticle(input.slug, input.versionNumber);
  });
