/** Content read handlers: staff workspace and article reads, and public news reads. */
import {
  readContentArticleHttpSourcePostgres,
  readContentAuthorityHttpSourcesPostgres,
  readPublishedNewsArticleHttpSourcePostgres,
  readPublishedNewsCollectionHttpSourcesPostgres,
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
  type PublishedNewsArticle,
  type PublishedNewsListing,
} from "@vektorprogrammet/domain/content";
import type { DepartmentId } from "@vektorprogrammet/domain/organization";
import {
  ListNewsEndpoint,
  ReadArticleEndpoint,
  ReadContentWorkspaceEndpoint,
  ReadNewsArticleEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Effect, Option } from "effect";
import { currentInstant } from "../authority.js";
import {
  authorizeAnonymous,
  conditionalJson,
  personPresentation,
  requireNoQuery,
  strictOutput,
  unreachable,
} from "../http-api/problem.js";
import { deriveStrongETag, PRIVATE_NO_STORE, PUBLIC_CACHE_CONTROL } from "../http-semantics.js";
import { articleContext, authorizeContentOperation } from "./http-access.js";
import { authorizedActor, type ContentRequestActorResolver } from "./http-context.js";
import { departmentQuery, versionFromQuery } from "./http-decode.js";
import { contentActorProblems, contentProblems } from "./http-problem.js";

export const readContentWorkspace = <E, R>(
  request: Request,
  department: DepartmentId | undefined,
  resolveActor: ContentRequestActorResolver<E, R>,
) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    const query = yield* departmentQuery(request, department);
    const actor = yield* authorizedActor(request, resolveActor, presentation);

    yield* authorizeContentOperation({
      endpoint: ReadContentWorkspaceEndpoint,
      request,
      personId: actor.personId,
      authorizationInstant: actor.authorizationInstant,
      resolution: {
        selection: "AllMatching",
        contexts: [
          {
            domainId: DomainId.make("content"),
            departmentId: query.departmentId ?? null,
            resource: null,
            facts: {},
            authorityVersion: AuthorityVersion.make(actor.authorizationInstant),
          },
        ],
      },
      presentation,
    });

    const workspace = yield* runContentWorkspace(actor.personId, actor.authorizationInstant, query);
    const body = yield* strictOutput(ContentWorkspaceSchema)(workspace);

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
    });
  }).pipe(
    contentProblems,
    contentActorProblems(presentation),
    // A workspace read names no article and runs no command.
    unreachable("content.article-not-found", "content.slug-conflict", "content.lifecycle-conflict"),
  );
};

export const readArticle = <E, R>(
  request: Request,
  articleId: ArticleId,
  resolveActor: ContentRequestActorResolver<E, R>,
) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);
    const actor = yield* authorizedActor(request, resolveActor, presentation);

    const [detail, source, authority] = yield* Effect.all([
      runContentArticleDetail(actor.personId, actor.authorizationInstant, articleId),
      readContentArticleHttpSourcePostgres(articleId),
      readContentAuthorityHttpSourcesPostgres(actor.personId),
    ]);

    yield* authorizeContentOperation({
      endpoint: ReadArticleEndpoint,
      request,
      personId: actor.personId,
      authorizationInstant: actor.authorizationInstant,
      resolution: {
        selection: "ExactlyOne",
        contexts: [articleContext(detail, source.createdByPersonId, actor.authorizationInstant)],
      },
      presentation,
    });

    const output = yield* strictOutput(ContentArticleDetailSchema)(detail);

    const etag = deriveStrongETag({
      representationKind: "ContentArticleDetailSchema",
      resourceIdentity: `content-article:${articleId}`,
      version: [
        source.articleRevision,
        source.authorProfileRevision,
        authority.map((item) => [item.kind, item.identity, item.revisions]),
      ],
    });

    return yield* conditionalJson({
      request,
      body: output,
      etag,
      cacheControl: PRIVATE_NO_STORE,
      contentType: "application/json",
    });
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

export const listNews = (request: Request, department: DepartmentId | undefined) =>
  Effect.gen(function* () {
    const query = yield* departmentQuery(request, department);

    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ListNewsEndpoint)),
      {
        selection: "AllMatching",
        contexts: [
          {
            domainId: DomainId.make("content"),
            departmentId: query.departmentId ?? null,
            resource: null,
            facts: {},
            authorityVersion: AuthorityVersion.make("public-news"),
          },
        ],
      },
      yield* currentInstant(undefined),
    );

    const listing = yield* readPublicNews(
      PublicNewsRead.Listing({ departmentId: query.departmentId }),
    );

    const [body, sources] = yield* Effect.all([
      // SAFETY: a listing read answers the listing.
      strictOutput(PublishedNewsListingSchema)(listing as PublishedNewsListing),
      readPublishedNewsCollectionHttpSourcesPostgres(query.departmentId),
    ]);

    const identity =
      query.departmentId === undefined ? "/api/news" : `/api/news?department=${query.departmentId}`;

    const etag = deriveStrongETag({
      representationKind: "PublishedNewsListing",
      resourceIdentity: identity,
      version: sources.map((source) => [
        source.articleId,
        source.currentVersionNumber,
        source.publishedAt,
        source.authorProfileRevision,
      ]),
    });

    return yield* conditionalJson({
      request,
      body,
      etag,
      cacheControl: PUBLIC_CACHE_CONTROL,
      contentType: "application/json",
    });
  }).pipe(
    contentProblems,
    // A listing read names no article.
    unreachable("content.article-not-found"),
  );

export const readNewsArticle = (request: Request, slug: string) =>
  Effect.gen(function* () {
    const versionNumber = yield* versionFromQuery(request);

    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(ReadNewsArticleEndpoint)),
      {
        selection: "ExactlyOne",
        contexts: [
          {
            domainId: DomainId.make("content"),
            departmentId: null,
            resource: {
              kind: ResourceKind.make("content-article"),
              id: ResourceId.make(slug),
            },
            facts: {},
            authorityVersion: AuthorityVersion.make("public-news"),
          },
        ],
      },
      yield* currentInstant(undefined),
    );

    const article = yield* readPublicNews(PublicNewsRead.Article({ slug, versionNumber }));

    const [body, source] = yield* Effect.all([
      // SAFETY: an article read answers the article.
      strictOutput(PublishedNewsArticleSchema)(article as PublishedNewsArticle),
      readPublishedNewsArticleHttpSourcePostgres(slug, versionNumber),
    ]);

    const etag = deriveStrongETag({
      representationKind: "PublishedNewsArticle",
      resourceIdentity:
        versionNumber === undefined
          ? `/api/news/${slug}`
          : `/api/news/${slug}?version=${versionNumber}`,
      version: [
        source.articleId,
        source.currentVersionNumber,
        source.selectedVersionNumber,
        source.publishedAt,
        source.authorProfileRevision,
      ],
    });

    return yield* conditionalJson({
      request,
      body,
      etag,
      cacheControl: PUBLIC_CACHE_CONTROL,
      contentType: "application/json",
    });
  }).pipe(
    contentProblems,
    // An article read filters no department.
    unreachable("content.department-not-found"),
  );
