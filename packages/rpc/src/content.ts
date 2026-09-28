/**
 * Content: staff article drafts and publication, and the public news they publish.
 *
 * @since 0.3.0
 */
import {
  ArticleId,
  ArticleSlug,
  ArticleVersionNumber,
  ContentWorkspaceQuerySchema,
  ContentWorkspaceSchema,
  PublishedNewsArticleSchema,
  PublishedNewsListingSchema,
  type ContentArticleDetail,
  type ContentWorkspace,
  type PublishedNewsArticle,
  type PublishedNewsListing,
} from "@vektorprogrammet/domain/content";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { anonymousNativeAccess, personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";
import {
  ArticleMergePatch,
  ContentArticleDetailSchema,
  CreateArticleRequest,
  PublishArticleResponse,
  UnpublishArticleResponse,
} from "./v2-schemas.js";

export {
  ArticleId,
  ArticleSlug,
  ArticleVersionNumber,
  ContentWorkspaceQuerySchema,
  ContentWorkspaceSchema,
  PublishedNewsArticleSchema,
  PublishedNewsListingSchema,
};

export type { ContentArticleDetail, ContentWorkspace, PublishedNewsArticle, PublishedNewsListing };

/**
 * One staff article beside the strong entity tag that `content.reviseArticle`,
 * `content.publishArticle`, and `content.unpublishArticle` take as `ifMatch`. The tag covers the
 * article revision, its author's profile revision, and the caller's content authority sources.
 */
export const ContentArticleResource = Schema.Struct({
  article: ContentArticleDetailSchema,
  etag: StrongETag,
}).annotate({ identifier: "ContentArticleResource" });

export type ContentArticleResource = typeof ContentArticleResource.Type;

/** A committed publication beside the article's new entity tag. */
export const PublishArticleResult = Schema.Struct({
  result: PublishArticleResponse,
  etag: StrongETag,
}).annotate({ identifier: "PublishArticleResult" });

export type PublishArticleResult = typeof PublishArticleResult.Type;

/** A committed unpublication beside the article's new entity tag. */
export const UnpublishArticleResult = Schema.Struct({
  result: UnpublishArticleResponse,
  etag: StrongETag,
}).annotate({ identifier: "UnpublishArticleResult" });

export type UnpublishArticleResult = typeof UnpublishArticleResult.Type;

/** Selects one published article by slug, and optionally one of its published versions. */
export const NewsArticleQuery = Schema.Struct({
  slug: ArticleSlug,
  version: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
}).annotate({ identifier: "NewsArticleQuery" });

export type NewsArticleQuery = typeof NewsArticleQuery.Type;

/** Problems of `content.readContentWorkspace`. */
export const ReadContentWorkspaceProblem = problemUnion("ReadContentWorkspaceProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "internal.error",
  "content.department-not-found",
  "content.integrity-error",
  "content.unavailable",
]);

/** Problems of `content.createArticle`. */
export const CreateArticleProblem = problemUnion("CreateArticleProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "idempotency.unavailable",
  "content.slug-conflict",
  "content.department-not-found",
  "content.integrity-error",
  "content.unavailable",
]);

/** Problems of `content.readArticle`. */
export const ReadArticleProblem = problemUnion("ReadArticleProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "internal.error",
  "content.article-not-found",
  "content.integrity-error",
  "content.unavailable",
]);

/** Problems of `content.reviseArticle`. */
export const ReviseArticleProblem = problemUnion("ReviseArticleProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "validation.no-change",
  "validation.field-not-deletable",
  "precondition.failed",
  "internal.error",
  "idempotency.unavailable",
  "content.article-not-found",
  "content.slug-conflict",
  "content.department-not-found",
  "content.integrity-error",
  "content.unavailable",
]);

/** Problems of `content.publishArticle` and `content.unpublishArticle`. */
const lifecycleProblems = [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "precondition.failed",
  "internal.error",
  "idempotency.unavailable",
  "content.article-not-found",
  "content.lifecycle-conflict",
  "content.integrity-error",
  "content.unavailable",
] as const;

/** Problems of `content.publishArticle`. */
export const PublishArticleProblem = problemUnion("PublishArticleProblem", lifecycleProblems);

/** Problems of `content.unpublishArticle`. */
export const UnpublishArticleProblem = problemUnion("UnpublishArticleProblem", lifecycleProblems);

/** Problems of `content.listNews`. */
export const ListNewsProblem = problemUnion("ListNewsProblem", [
  "internal.error",
  "content.department-not-found",
  "content.integrity-error",
  "content.unavailable",
]);

/** Problems of `content.readNewsArticle`. */
export const ReadNewsArticleProblem = problemUnion("ReadNewsArticleProblem", [
  "internal.error",
  "content.article-not-found",
  "content.integrity-error",
  "content.unavailable",
]);

/** Returns the article drafts visible to the current staff person, optionally of one department. */
export const ReadContentWorkspace = Rpc.make("content.readContentWorkspace", {
  payload: ContentWorkspaceQuerySchema,
  success: ContentWorkspaceSchema,
  error: rpcProblems(ReadContentWorkspaceProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "content.read-workspace",
        canonicalScopeResolver: "content.articles",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/** Creates, or replays by its idempotency key, one native article draft. */
export const CreateArticle = Rpc.make("content.createArticle", {
  payload: Schema.Struct({ idempotencyKey: IdempotencyKey, request: CreateArticleRequest }),
  success: ContentArticleResource,
  error: rpcProblems(CreateArticleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "content.create-article",
        canonicalScopeResolver: "content.article-create",
        decisionTime: "Transaction",
      }),
    ),
  );

/** Returns one staff article detail beside its entity tag. */
export const ReadArticle = Rpc.make("content.readArticle", {
  payload: Schema.Struct({ articleId: ArticleId }),
  success: ContentArticleResource,
  error: rpcProblems(ReadArticleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "content.read-article",
        canonicalScopeResolver: "content.article-by-id",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * Applies a JSON merge patch (RFC 7396) to a draft under its entity tag. An absent member keeps
 * its value; a patch with no member answers validation.no-change, and a `null` member
 * validation.field-not-deletable.
 */
export const ReviseArticle = Rpc.make("content.reviseArticle", {
  payload: Schema.Struct({
    articleId: ArticleId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: ArticleMergePatch,
  }),
  success: ContentArticleResource,
  error: rpcProblems(ReviseArticleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "content.revise-article",
        canonicalScopeResolver: "content.article-by-id",
        requirements: ["content.revisable"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** The payload of a publication transition: the article, the key, and its entity tag. */
const ArticleTransitionPayload = Schema.Struct({
  articleId: ArticleId,
  idempotencyKey: IdempotencyKey,
  ifMatch: StrongETag,
});

/** Publishes a new immutable version of an article under its entity tag. */
export const PublishArticle = Rpc.make("content.publishArticle", {
  payload: ArticleTransitionPayload,
  success: PublishArticleResult,
  error: rpcProblems(PublishArticleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "content.publish-article",
        canonicalScopeResolver: "content.article-by-id",
        requirements: ["content.publishable"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Removes an article from the public current listing under its entity tag. */
export const UnpublishArticle = Rpc.make("content.unpublishArticle", {
  payload: ArticleTransitionPayload,
  success: UnpublishArticleResult,
  error: rpcProblems(UnpublishArticleProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "content.publish-article",
        canonicalScopeResolver: "content.article-by-id",
        requirements: ["content.unpublishable"],
        decisionTime: "Transaction",
      }),
    ),
  );

/** Returns the current public news listing, optionally of one department. */
export const ListNews = Rpc.make("content.listNews", {
  payload: ContentWorkspaceQuerySchema,
  success: PublishedNewsListingSchema,
  error: rpcProblems(ListNewsProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("content.public-news")));

/** Returns the current, or the selected, published version of one news article. */
export const ReadNewsArticle = Rpc.make("content.readNewsArticle", {
  payload: NewsArticleQuery,
  success: PublishedNewsArticleSchema,
  error: rpcProblems(ReadNewsArticleProblem),
}).pipe(withAccessSpec(anonymousNativeAccess("content.public-news-by-slug")));

export class ContentRpcs extends RpcGroup.make(
  ReadContentWorkspace,
  CreateArticle,
  ReadArticle,
  ReviseArticle,
  PublishArticle,
  UnpublishArticle,
  ListNews,
  ReadNewsArticle,
) {}
