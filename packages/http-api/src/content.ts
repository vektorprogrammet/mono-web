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
} from "@vektorprogrammet/domain/content";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
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

/** @since 0.1.0 @category Endpoints */
export const ReadContentWorkspaceEndpoint = HttpApiEndpoint.get(
  "readContentWorkspace",
  "/api/admin/content/workspace",
  { query: ContentDepartmentQuery, success: ContentWorkspaceSchema, error: ContentErrors },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Read content workspace",
      "Returns article drafts visible to the current staff actor.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const CreateArticleEndpoint = HttpApiEndpoint.post(
  "createArticle",
  "/api/admin/content/articles",
  {
    payload: CreateArticleDraftInputSchema,
    success: ArticleDraft.json.pipe(HttpApiSchema.status(201)),
    error: ContentErrors,
  },
)
  .middleware(SessionSecurity)
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
  "/api/admin/content/articles/:articleId",
  { params: ArticleParams, success: ContentArticleDetailSchema, error: ContentErrors },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations("Read article detail", "Returns one staff article detail projection."),
  );

/** @since 0.1.0 @category Endpoints */
export const ReviseArticleEndpoint = HttpApiEndpoint.put(
  "reviseArticle",
  "/api/admin/content/articles/:articleId",
  {
    params: ArticleParams,
    payload: ReviseArticleDraftInputSchema,
    success: ArticleDraft.json,
    error: ContentErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Revise article draft",
      "Revises a draft with optimistic revision control.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const PublishArticleEndpoint = HttpApiEndpoint.post(
  "publishArticle",
  "/api/admin/content/articles/:articleId/publish",
  {
    params: ArticleParams,
    payload: PublishArticleInputSchema,
    success: PublishObservationSchema,
    error: ContentErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations("Publish article", "Publishes a new immutable article version."),
  );

/** @since 0.1.0 @category Endpoints */
export const UnpublishArticleEndpoint = HttpApiEndpoint.post(
  "unpublishArticle",
  "/api/admin/content/articles/:articleId/unpublish",
  {
    params: ArticleParams,
    payload: UnpublishArticleInputSchema,
    success: UnpublishObservationSchema,
    error: ContentErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Unpublish article",
      "Removes an article from the public current listing.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ListNewsEndpoint = HttpApiEndpoint.get("listNews", "/api/news", {
  query: ContentDepartmentQuery,
  success: PublishedNewsListingSchema,
  error: ContentErrors,
}).annotateMerge(
  operationAnnotations("List published news", "Returns the current public native news listing."),
);

/** @since 0.1.0 @category Endpoints */
export const ReadNewsArticleEndpoint = HttpApiEndpoint.get("readNewsArticle", "/api/news/:slug", {
  params: { slug: Schema.String.pipe(Schema.check(Schema.isMinLength(1))) },
  query: NewsVersionQuery,
  success: PublishedNewsArticleSchema,
  error: ContentErrors,
}).annotateMerge(
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
