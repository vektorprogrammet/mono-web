/** Content read handlers: staff workspace and article reads, and public news reads. */
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
  type PublishedNewsArticle,
  type PublishedNewsListing,
} from "@vektorprogrammet/domain/content";
import type { DepartmentId } from "@vektorprogrammet/domain/organization";
import { Effect } from "effect";
import { currentInstant } from "../authority.js";
import {
  conditionalJson,
  personPresentation,
  requireNoQuery,
  strictOutput,
  unreachable,
  jsonText,
} from "../http-api/problem.js";
import { deriveStrongETag, PRIVATE_NO_STORE, PUBLIC_CACHE_CONTROL } from "../http-semantics.js";
import { articleContext, CurrentContentAccess } from "./http-access.js";
import {
  authorizedActor,
  type ContentAuthorizer,
  type ContentRequestActorResolver,
} from "./http-context.js";
import { departmentQuery, versionFromQuery } from "./http-decode.js";
import { contentActorProblems, contentProblems } from "./http-problem.js";

export const readContentWorkspace = <E, R, EA, RA>(
  request: Request,
  department: DepartmentId | undefined,
  resolveActor: ContentRequestActorResolver<E, R>,
  authorize: ContentAuthorizer<EA, RA>,
) => {
  const presentation = personPresentation(request);

  return Effect.gen(function* () {
    const query = yield* departmentQuery(request, department);
    const actor = yield* authorizedActor(request, resolveActor, presentation);

    yield* authorize().pipe(
      Effect.provideService(CurrentContentAccess, {
        kind: "StaffRead",
        operation: "content.readContentWorkspace",
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
      }),
    );

    const workspace = yield* runContentWorkspace(actor.personId, actor.authorizationInstant, query);
    const body = yield* strictOutput(ContentWorkspaceSchema)(workspace);

    return new Response(yield* jsonText(body), {
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

export const readArticle = <E, R, EA, RA>(
  request: Request,
  articleId: ArticleId,
  resolveActor: ContentRequestActorResolver<E, R>,
  authorize: ContentAuthorizer<EA, RA>,
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

    yield* authorize().pipe(
      Effect.provideService(CurrentContentAccess, {
        kind: "StaffRead",
        operation: "content.readArticle",
        request,
        actor,
        resolution: {
          selection: "ExactlyOne",
          contexts: [articleContext(detail, source.createdByPersonId, actor.authorizationInstant)],
        },
      }),
    );

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

export const listNews = <EA, RA>(
  request: Request,
  department: DepartmentId | undefined,
  authorize: ContentAuthorizer<EA, RA>,
) =>
  Effect.gen(function* () {
    const query = yield* departmentQuery(request, department);
    const now = yield* currentInstant(undefined);

    yield* authorize().pipe(
      Effect.provideService(CurrentContentAccess, {
        kind: "Public",
        operation: "content.listNews",
        resolution: {
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
        now,
      }),
    );

    const listing = yield* readPublicNews(
      PublicNewsRead.Listing({ departmentId: query.departmentId }),
    );

    // SAFETY: a listing read answers the listing. Strict decoding fixes the public shape
    // before its serialized bytes become both the validator source and the response.
    const body = yield* strictOutput(PublishedNewsListingSchema)(listing as PublishedNewsListing);
    const encodedBody = yield* jsonText(body);

    const identity =
      query.departmentId === undefined ? "/api/news" : `/api/news?department=${query.departmentId}`;

    const etag = deriveStrongETag({
      representationKind: "PublishedNewsListing",
      resourceIdentity: identity,
      version: encodedBody,
    });

    return yield* conditionalJson({
      request,
      encodedBody,
      etag,
      cacheControl: PUBLIC_CACHE_CONTROL,
      contentType: "application/json",
    });
  }).pipe(
    contentProblems,
    // A listing read names no article.
    unreachable("content.article-not-found"),
  );

export const readNewsArticle = <EA, RA>(
  request: Request,
  slug: string,
  authorize: ContentAuthorizer<EA, RA>,
) =>
  Effect.gen(function* () {
    const versionNumber = yield* versionFromQuery(request);
    const now = yield* currentInstant(undefined);

    yield* authorize().pipe(
      Effect.provideService(CurrentContentAccess, {
        kind: "Public",
        operation: "content.readNewsArticle",
        resolution: {
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
        now,
      }),
    );

    const article = yield* readPublicNews(PublicNewsRead.Article({ slug, versionNumber }));

    // SAFETY: an article read answers the article. Hash exactly the bytes sent to clients.
    const body = yield* strictOutput(PublishedNewsArticleSchema)(article as PublishedNewsArticle);
    const encodedBody = yield* jsonText(body);

    const etag = deriveStrongETag({
      representationKind: "PublishedNewsArticle",
      resourceIdentity:
        versionNumber === undefined
          ? `/api/news/${slug}`
          : `/api/news/${slug}?version=${versionNumber}`,
      version: encodedBody,
    });

    return yield* conditionalJson({
      request,
      encodedBody,
      etag,
      cacheControl: PUBLIC_CACHE_CONTROL,
      contentType: "application/json",
    });
  }).pipe(
    contentProblems,
    // An article read filters no department.
    unreachable("content.department-not-found"),
  );
