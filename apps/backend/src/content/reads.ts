/** Content reads: the staff workspace and article detail, and the public news. */
import {
  readContentArticleHttpSourcePostgres,
  readContentAuthorityHttpSourcesPostgres,
} from "@vektorprogrammet/database/content";
import {
  AuthorityVersion,
  DomainId,
  ResourceId,
  ResourceKind,
} from "@vektorprogrammet/domain/authz";
import {
  ContentArticleDetailSchema,
  ContentWorkspaceSchema,
  PublicNewsRead,
  PublishedNewsArticleSchema,
  PublishedNewsListingSchema,
  readPublicNews,
  runContentArticleDetail,
  runContentWorkspace,
  type ArticleId,
  type ArticleSlug,
  type ContentWorkspaceQuery,
  type PublishedNewsArticle,
  type PublishedNewsListing,
} from "@vektorprogrammet/domain/content";
import {
  type ContentArticleResource,
  ListNews,
  ReadArticle,
  ReadContentWorkspace,
  ReadNewsArticle,
  reflectAccessSpec,
} from "@vektorprogrammet/rpc";
import { Effect, Option } from "effect";
import type { Headers } from "effect/unstable/http";
import { currentInstant } from "../authority.js";
import { credentialRequestOf } from "../rpc/credential.js";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  authorizeAnonymous,
  personPresentation,
  strictOutput,
  unreachable,
} from "../rpc/problem.js";
import {
  articleContext,
  articleETag,
  authorizeContentOperation,
  unscopedContext,
} from "./access.js";
import { readActor } from "./context.js";
import { contentActorProblems, contentProblems } from "./problem.js";

/** The article drafts that the staff person may see, optionally of one department. */
export const readContentWorkspace = (input: {
  readonly headers: Headers.Headers;
  readonly query: ContentWorkspaceQuery;
  readonly options: NativeRpcOptions;
}) => {
  const presentation = personPresentation(input.headers);

  return Effect.gen(function* () {
    const actor = yield* readActor({ headers: input.headers, now: input.options.now });

    yield* authorizeContentOperation({
      rpc: ReadContentWorkspace,
      request: credentialRequestOf(input.headers),
      personId: actor.personId,
      authorizationInstant: actor.authorizationInstant,
      resolution: {
        selection: "AllMatching",
        contexts: [
          unscopedContext({
            departmentId: input.query.departmentId ?? null,
            authorityVersion: actor.authorizationInstant,
          }),
        ],
      },
      presentation,
    });

    const query: ContentWorkspaceQuery =
      input.query.departmentId === undefined ? {} : { departmentId: input.query.departmentId };

    const workspace = yield* runContentWorkspace(actor.personId, actor.authorizationInstant, query);

    return yield* strictOutput(ContentWorkspaceSchema)(workspace);
  }).pipe(
    contentProblems,
    contentActorProblems(presentation),
    // A workspace read names no article and runs no command.
    unreachable("content.article-not-found", "content.slug-conflict", "content.lifecycle-conflict"),
  );
};

/** One staff article detail beside the entity tag that its commands take as `ifMatch`. */
export const readArticle = (input: {
  readonly headers: Headers.Headers;
  readonly articleId: ArticleId;
  readonly options: NativeRpcOptions;
}) => {
  const presentation = personPresentation(input.headers);
  const { articleId } = input;

  return Effect.gen(function* () {
    const actor = yield* readActor({ headers: input.headers, now: input.options.now });

    const [detail, source, authority] = yield* Effect.all([
      runContentArticleDetail(actor.personId, actor.authorizationInstant, articleId),
      readContentArticleHttpSourcePostgres(articleId),
      readContentAuthorityHttpSourcesPostgres(actor.personId),
    ]);

    yield* authorizeContentOperation({
      rpc: ReadArticle,
      request: credentialRequestOf(input.headers),
      personId: actor.personId,
      authorizationInstant: actor.authorizationInstant,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          articleContext({
            detail,
            createdByPersonId: source.createdByPersonId,
            authorityVersion: actor.authorizationInstant,
          }),
        ],
      },
      presentation,
    });

    const article = yield* strictOutput(ContentArticleDetailSchema)(detail);

    return {
      article,
      etag: articleETag({ articleId, source, authority }),
    } satisfies ContentArticleResource;
  }).pipe(
    contentProblems,
    contentActorProblems(presentation),
    // A detail read changes no slug, department, or lifecycle state.
    unreachable(
      "content.slug-conflict",
      "content.department-not-found",
      "content.lifecycle-conflict",
    ),
  );
};

/** The current public news listing, optionally of one department. */
export const listNews = (query: ContentWorkspaceQuery) =>
  Effect.gen(function* () {
    const departmentId = query.departmentId;

    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ListNews)),
      {
        selection: "AllMatching",
        contexts: [
          unscopedContext({ departmentId: departmentId ?? null, authorityVersion: "public-news" }),
        ],
      },
      yield* currentInstant(undefined),
    );

    const listing = yield* readPublicNews(PublicNewsRead.Listing({ departmentId }));

    // SAFETY: a listing read answers the listing.
    return yield* strictOutput(PublishedNewsListingSchema)(listing as PublishedNewsListing);
  }).pipe(
    contentProblems,
    // A listing read names no article.
    unreachable("content.article-not-found"),
  );

/** The current, or the selected, published version of one news article. */
export const readNewsArticle = (input: {
  readonly slug: ArticleSlug;
  readonly version?: number | undefined;
}) =>
  Effect.gen(function* () {
    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ReadNewsArticle)),
      {
        selection: "ExactlyOne",
        contexts: [
          {
            domainId: DomainId.make("content"),
            departmentId: null,
            resource: {
              kind: ResourceKind.make("content-article"),
              id: ResourceId.make(input.slug),
            },
            facts: {},
            authorityVersion: AuthorityVersion.make("public-news"),
          },
        ],
      },
      yield* currentInstant(undefined),
    );

    const article = yield* readPublicNews(
      PublicNewsRead.Article({ slug: input.slug, versionNumber: input.version }),
    );

    // SAFETY: an article read answers the article.
    return yield* strictOutput(PublishedNewsArticleSchema)(article as PublishedNewsArticle);
  }).pipe(
    contentProblems,
    // An article read filters no department.
    unreachable("content.department-not-found"),
  );
