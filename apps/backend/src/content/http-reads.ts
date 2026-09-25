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
} from "@vektorprogrammet/domain/content";
import {
  ListNewsEndpoint,
  ReadArticleEndpoint,
  ReadContentWorkspaceEndpoint,
  ReadNewsArticleEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Effect, Option } from "effect";
import { deriveStrongETag } from "../http-semantics.js";
import {
  articleContext,
  authorizeAnonymousContentOperation,
  authorizeContentOperation,
} from "./http-access.js";
import { authorizedActor, type ContentRequestActorResolver } from "./http-context.js";
import { departmentFromQuery, rejectQueryString, versionFromQuery } from "./http-decode.js";
import { conditionalJsonResponse, strictOutput } from "./http-representation.js";

const PRIVATE_NO_STORE = "private, no-store";

const PUBLIC_NEWS_CACHE = "public, max-age=60, s-maxage=300, must-revalidate";

export const readContentWorkspace = <E, R>(
  request: Request,
  resolveActor: ContentRequestActorResolver<E, R>,
) =>
  Effect.gen(function* () {
    const query = yield* departmentFromQuery(request);
    const actor = yield* authorizedActor(request, resolveActor);
    yield* authorizeContentOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadContentWorkspaceEndpoint)),
      request,
      actor,
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
    });
    const workspace = yield* runContentWorkspace(actor.personId, actor.authorizationInstant, query);
    const body = yield* strictOutput(ContentWorkspaceSchema)(workspace);

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "cache-control": PRIVATE_NO_STORE, "content-type": "application/json" },
    });
  });

export const readArticle = <E, R>(
  request: Request,
  articleId: ArticleId,
  resolveActor: ContentRequestActorResolver<E, R>,
) =>
  Effect.gen(function* () {
    yield* rejectQueryString(request);
    const actor = yield* authorizedActor(request, resolveActor);

    const [detail, source, authority] = yield* Effect.all([
      runContentArticleDetail(actor.personId, actor.authorizationInstant, articleId),
      readContentArticleHttpSourcePostgres(articleId),
      readContentAuthorityHttpSourcesPostgres(actor.personId),
    ]);

    yield* authorizeContentOperation({
      spec: Option.getOrThrow(reflectAccessSpec(ReadArticleEndpoint)),
      request,
      actor,
      resolution: {
        selection: "ExactlyOne",
        contexts: [articleContext(detail, source.createdByPersonId, actor.authorizationInstant)],
      },
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

    return yield* conditionalJsonResponse(request, output, etag, PRIVATE_NO_STORE);
  });

export const listNews = (request: Request) =>
  Effect.gen(function* () {
    const query = yield* departmentFromQuery(request);
    yield* authorizeAnonymousContentOperation(
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
    );

    const listing = yield* readPublicNews(
      PublicNewsRead.Listing({ departmentId: query.departmentId }),
    );

    const [body, sources] = yield* Effect.all([
      strictOutput(PublishedNewsListingSchema)(listing),
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

    return yield* conditionalJsonResponse(request, body, etag, PUBLIC_NEWS_CACHE);
  });

export const readNewsArticle = (request: Request, slug: string) =>
  Effect.gen(function* () {
    const versionNumber = yield* versionFromQuery(request);
    yield* authorizeAnonymousContentOperation(
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
    );
    const article = yield* readPublicNews(PublicNewsRead.Article({ slug, versionNumber }));

    const [body, source] = yield* Effect.all([
      strictOutput(PublishedNewsArticleSchema)(article),
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

    return yield* conditionalJsonResponse(request, body, etag, PUBLIC_NEWS_CACHE);
  });
