/**
 * Public HTTP contracts for staff content and published news.
 *
 * @since 0.1.0
 */
import {
  ArticleDraft,
  ArticleId,
  ContentArticleDetailSchema,
  ContentWorkspaceSchema,
  CreateArticleDraftInputSchema,
  PublishArticleInputSchema,
  PublishObservationSchema,
  PublishedNewsArticleSchema,
  PublishedNewsListingSchema,
  ReviseArticleDraftInputSchema,
  UnpublishArticleInputSchema,
  UnpublishObservationSchema,
  ArticleSlug,
  ArticleVersionNumber,
  ContentCommandId,
} from "@vektorprogrammet/domain/content";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, anonymousNativeAccess, personNativeAccess } from "./access.js";
import { errorBody, operationAnnotations, SessionSecurity } from "./common.js";

/**
 * Optional public/staff department filter using the transport key.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const ContentDepartmentQuery = {
  department: Schema.optional(DepartmentId),
};

/**
 * Optional positive published-version selector.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const NewsVersionQuery = {
  version: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
};

const ContentForbiddenResponse = errorBody(
  "ContentForbiddenResponse",
  ["AuthorityInactive", "NotInScope", "NotPublisher", "DraftNotOwned"],
  403,
);
const ContentNotFoundResponse = errorBody("ContentNotFoundResponse", ["ArticleNotFound"], 404);
const ContentConflictResponse = errorBody("ContentConflictResponse", ["CommandConflict"], 409);
const ContentDecodeResponse = errorBody(
  "ContentDecodeResponse",
  ["SlugConflict", "ContentDecodeError", "DepartmentNotFound"],
  422,
);
const ContentUnavailableResponse = errorBody(
  "ContentUnavailableResponse",
  ["ContentIntegrityError", "ContentPersistenceError"],
  503,
);
const ContentErrors = [
  ContentForbiddenResponse,
  ContentNotFoundResponse,
  ContentConflictResponse,
  ContentDecodeResponse,
  ContentUnavailableResponse,
] as const;

export const WorkspaceEntryExample = {
  articleId: ArticleId.make(1),
  title: "Penerimaan Anggota Baru 2026",
  slug: ArticleSlug.make("penerimaan-anggota-2026"),
  status: "Draft",
  sticky: false,
  updatedAt: "2026-08-24T09:00:00.000Z",
  departmentIds: [DepartmentId.make("1")],
  canRevise: true,
  canPublish: true,
  authorDisplayName: "Kari Penerbit",
} as const;

export const ArticleDetailExample = {
  articleId: ArticleId.make(1),
  title: "Penerimaan Anggota Baru 2026",
  slug: ArticleSlug.make("penerimaan-anggota-2026"),
  status: "Draft",
  bodyHtml: "<p>Informasi penerimaan anggota baru tahun 2026.</p>",
  sticky: false,
  createdAt: "2026-08-20T09:00:00.000Z",
  updatedAt: "2026-08-24T09:00:00.000Z",
  currentVersionNumber: null,
  revision: 0,
  departmentIds: [DepartmentId.make("1")],
  canRevise: true,
  canPublish: true,
  authorDisplayName: "Kari Penerbit",
} as const;

export const CreateArticleInputExample = {
  commandId: ContentCommandId.make("content-command-0080"),
  title: "Penerimaan Anggota Baru 2026",
  bodyHtml: "<p>Informasi penerimaan anggota baru tahun 2026.</p>",
  departmentIds: [DepartmentId.make("1")],
  sticky: false,
} as const;

export const ReviseArticleInputExample = {
  commandId: ContentCommandId.make("content-revise-0080"),
  articleId: ArticleId.make(1),
  expectedRevision: 0,
  title: "Penerimaan Anggota Baru 2026",
  bodyHtml: "<p>Informasi penerimaan anggota baru tahun 2026.</p>",
  departmentIds: [DepartmentId.make("1")],
} as const;

export const PublishArticleInputExample = {
  commandId: ContentCommandId.make("publish-command-0080"),
  articleId: ArticleId.make(1),
} as const;

export const UnpublishArticleInputExample = {
  commandId: ContentCommandId.make("unpublish-command-0080"),
  articleId: ArticleId.make(1),
} as const;

export const PublishObservationExample = {
  _tag: "Published",
  commandId: ContentCommandId.make("publish-command-0080"),
  articleId: ArticleId.make(1),
  versionNumber: ArticleVersionNumber.make(1),
  publishedAt: "2026-08-25T08:00:00.000Z",
} as const;

export const UnpublishObservationExample = {
  _tag: "Unpublished",
  commandId: ContentCommandId.make("unpublish-command-0080"),
  articleId: ArticleId.make(1),
} as const;

export const NewsListingExample = {
  articles: [
    {
      slug: ArticleSlug.make("penerimaan-anggota-2026"),
      title: "Penerimaan Anggota Baru 2026",
      sticky: true,
      publishedAt: "2026-08-25T08:00:00.000Z",
      authorDisplayName: "Kari Penerbit",
      departmentIds: [DepartmentId.make("1")],
      hasImage: false,
    },
  ],
} as const;

export const NewsArticleExample = {
  slug: ArticleSlug.make("penerimaan-anggota-2026"),
  title: "Penerimaan Anggota Baru 2026",
  sticky: true,
  publishedAt: "2026-08-25T08:00:00.000Z",
  authorDisplayName: "Kari Penerbit",
  departmentIds: [DepartmentId.make("1")],
  hasImage: false,
  bodyHtml: "<p>Informasi penerimaan anggota baru tahun 2026.</p>",
  previousVersions: [],
} as const;

/** @since 0.1.0 @category Endpoints */
export const ReadContentWorkspaceEndpoint = HttpApiEndpoint.get(
  "readContentWorkspace",
  "/api/content/articles",
  { query: ContentDepartmentQuery, success: ContentWorkspaceSchema, error: ContentErrors },
)
  .middleware(SessionSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "content.read-workspace",
        canonicalScopeResolver: "content.articles",
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Read content workspace",
      "Returns article drafts visible to the current staff actor.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const CreateArticleEndpoint = HttpApiEndpoint.post(
  "createArticle",
  "/api/content/articles",
  {
    payload: CreateArticleDraftInputSchema.annotate({
      identifier: "CreateArticleDraftInput",
      description: "Idempotent create-draft command.",
      examples: [CreateArticleInputExample],
    }),
    success: ArticleDraft.json.pipe(HttpApiSchema.status(201)),
    error: ContentErrors,
  },
)
  .middleware(SessionSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "content.create-article",
        canonicalScopeResolver: "content.article-create",
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Create article draft",
      "Creates or replays a native article draft command.",
    ),
  );

const ArticleParams = { articleId: ArticleId };

/** @since 0.1.0 @category Endpoints */
export const ReadArticleEndpoint = HttpApiEndpoint.get(
  "readArticle",
  "/api/content/articles/:articleId",
  { params: ArticleParams, success: ContentArticleDetailSchema, error: ContentErrors },
)
  .middleware(SessionSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "content.read-article",
        canonicalScopeResolver: "content.article-by-id",
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("Read article detail", "Returns one staff article detail projection."),
  );

/** @since 0.1.0 @category Endpoints */
export const ReviseArticleEndpoint = HttpApiEndpoint.patch(
  "reviseArticle",
  "/api/content/articles/:articleId",
  {
    params: ArticleParams,
    payload: ReviseArticleDraftInputSchema.annotate({
      identifier: "ReviseArticleDraftInput",
      description: "Idempotent revise command with optimistic revision.",
      examples: [ReviseArticleInputExample],
    }),
    success: ArticleDraft.json,
    error: ContentErrors,
  },
)
  .middleware(SessionSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "content.revise-article",
        canonicalScopeResolver: "content.article-by-id",
        requirements: ["content.draft", "content.owner"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Revise article draft",
      "Revises a draft with optimistic revision control.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const PublishArticleEndpoint = HttpApiEndpoint.post(
  "publishArticle",
  "/api/content/articles/:articleId::publish",
  {
    params: ArticleParams,
    payload: PublishArticleInputSchema.annotate({
      identifier: "PublishArticleInput",
      description: "Idempotent publish command.",
      examples: [PublishArticleInputExample],
    }),
    success: PublishObservationSchema.annotate({
      identifier: "PublishObservation",
      description: "Published version observation.",
      examples: [PublishObservationExample],
    }),
    error: ContentErrors,
  },
)
  .middleware(SessionSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "content.publish-article",
        canonicalScopeResolver: "content.article-by-id",
        requirements: ["content.publishable"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations("Publish article", "Publishes a new immutable article version."),
  );

/** @since 0.1.0 @category Endpoints */
export const UnpublishArticleEndpoint = HttpApiEndpoint.post(
  "unpublishArticle",
  "/api/content/articles/:articleId::unpublish",
  {
    params: ArticleParams,
    payload: UnpublishArticleInputSchema.annotate({
      identifier: "UnpublishArticleInput",
      description: "Idempotent unpublish command.",
      examples: [UnpublishArticleInputExample],
    }),
    success: UnpublishObservationSchema.annotate({
      identifier: "UnpublishObservation",
      description: "Unpublish observation.",
      examples: [UnpublishObservationExample],
    }),
    error: ContentErrors,
  },
)
  .middleware(SessionSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "content.publish-article",
        canonicalScopeResolver: "content.article-by-id",
        requirements: ["content.unpublishable"],
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Unpublish article",
      "Removes an article from the public current listing.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ListNewsEndpoint = HttpApiEndpoint.get("listNews", "/api/news", {
  query: ContentDepartmentQuery,
  success: PublishedNewsListingSchema.annotate({
    identifier: "PublishedNewsListing",
    description: "Current public news listing.",
    examples: [NewsListingExample],
  }),
  error: ContentErrors,
})
  .pipe((endpoint) => annotateAccessSpec(endpoint, anonymousNativeAccess("content.public-news")))
  .annotateMerge(
    operationAnnotations("List published news", "Returns the current public native news listing."),
  );

/** @since 0.1.0 @category Endpoints */
export const ReadNewsArticleEndpoint = HttpApiEndpoint.get("readNewsArticle", "/api/news/:slug", {
  params: { slug: Schema.String.pipe(Schema.check(Schema.isMinLength(1))) },
  query: NewsVersionQuery,
  success: PublishedNewsArticleSchema.annotate({
    identifier: "PublishedNewsArticle",
    description: "One published news article.",
    examples: [NewsArticleExample],
  }),
  error: ContentErrors,
})
  .pipe((endpoint) =>
    annotateAccessSpec(endpoint, anonymousNativeAccess("content.public-news-by-slug")),
  )
  .annotateMerge(
    operationAnnotations(
      "Read published news article",
      "Returns the current or selected published version.",
    ),
  );

/**
 * Staff content management and public news API.
 *
 * @since 0.1.0
 * @category Groups
 */
export class ContentApi extends HttpApiGroup.make("content")
  .add(
    ReadContentWorkspaceEndpoint,
    CreateArticleEndpoint,
    ReadArticleEndpoint,
    ReviseArticleEndpoint,
    PublishArticleEndpoint,
    UnpublishArticleEndpoint,
    ListNewsEndpoint,
    ReadNewsArticleEndpoint,
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Content and news",
      description: "Native staff publication and public news operations.",
    }),
  ) {}
