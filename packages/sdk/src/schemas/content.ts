import { Schema } from "effect";
import { DepartmentId } from "./organization.js";

export { DepartmentId };

const text = (maxLength: number) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => value.trim().length > 0, {
        message: "a non-empty string",
      }),
      Schema.isMaxLength(maxLength),
    ),
  );

const positiveSafeInt = (brandName: string) =>
  Schema.Int.pipe(
    Schema.check(
      Schema.makeFilter(Number.isSafeInteger, { message: "a safe integer" }),
      Schema.isGreaterThan(0),
    ),
    Schema.brand(brandName),
  );

export const ArticleId = positiveSafeInt("ArticleId");
export type ArticleId = typeof ArticleId.Type;

export const ArticleVersionNumber = positiveSafeInt("ArticleVersionNumber");
export type ArticleVersionNumber = typeof ArticleVersionNumber.Type;

export const ContentCommandId = text(255).pipe(Schema.brand("ContentCommandId"));
export type ContentCommandId = typeof ContentCommandId.Type;

const DepartmentIds = Schema.Array(DepartmentId);

// --- Staff workspace shapes ---

export const ContentWorkspaceEntrySchema = Schema.Struct({
  articleId: ArticleId,
  title: text(255),
  slug: text(255).pipe(
    Schema.check(
      Schema.makeFilter((value) => /^[a-z0-9-]+$/.test(value), {
        message: "a lowercase slug of letters, digits, and hyphens",
      }),
    ),
  ),
  status: Schema.Literals(["Draft", "Published"]),
  sticky: Schema.Boolean,
  updatedAt: Schema.String,
  departmentIds: DepartmentIds,
  canRevise: Schema.Boolean,
  canPublish: Schema.Boolean,
  authorDisplayName: text(255),
});
export type ContentWorkspaceEntry = typeof ContentWorkspaceEntrySchema.Type;

export const ContentWorkspaceSchema = Schema.Struct({
  entries: Schema.Array(ContentWorkspaceEntrySchema),
});
export type ContentWorkspace = typeof ContentWorkspaceSchema.Type;

export interface AdminContentWorkspaceInput {
  readonly department?: DepartmentId;
}

// --- Public news shapes ---

export const PublishedNewsSummarySchema = Schema.Struct({
  slug: text(255).pipe(
    Schema.check(
      Schema.makeFilter((value) => /^[a-z0-9-]+$/.test(value), {
        message: "a lowercase slug of letters, digits, and hyphens",
      }),
    ),
  ),
  title: text(255),
  sticky: Schema.Boolean,
  publishedAt: Schema.String,
  authorDisplayName: text(255),
  departmentIds: DepartmentIds,
  hasImage: Schema.Boolean,
  imageUrl: Schema.optional(Schema.String),
});
export type PublishedNewsSummary = typeof PublishedNewsSummarySchema.Type;

export const PublishedNewsListingSchema = Schema.Struct({
  articles: Schema.Array(PublishedNewsSummarySchema),
});
export type PublishedNewsListing = typeof PublishedNewsListingSchema.Type;

export const PublishedNewsVersionRefSchema = Schema.Struct({
  versionNumber: ArticleVersionNumber,
  publishedAt: Schema.String,
  urlPath: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => value.startsWith("/nyhet/"), {
        message: "a stable /nyhet/ version path",
      }),
    ),
  ),
});
export type PublishedNewsVersionRef = typeof PublishedNewsVersionRefSchema.Type;

export const PublishedNewsArticleSchema = Schema.Struct({
  slug: PublishedNewsSummarySchema.fields.slug,
  title: PublishedNewsSummarySchema.fields.title,
  sticky: Schema.Boolean,
  publishedAt: Schema.String,
  authorDisplayName: text(255),
  departmentIds: DepartmentIds,
  hasImage: Schema.Boolean,
  imageUrl: Schema.optional(Schema.String),
  bodyHtml: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => value.length <= 100000, {
        message: "an article body within the 100000-byte limit",
      }),
    ),
  ),
  previousVersions: Schema.Array(PublishedNewsVersionRefSchema),
});
export type PublishedNewsArticle = typeof PublishedNewsArticleSchema.Type;

export interface PublicNewsListInput {
  readonly department?: DepartmentId;
}

// --- Command bodies ---

export const CreateContentDraftCommandSchema = Schema.Struct({
  commandId: ContentCommandId,
  title: text(255),
  bodyHtml: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => value.length <= 100000, {
        message: "an article body within the 100000-byte limit",
      }),
    ),
  ),
  departmentIds: Schema.Array(DepartmentId).pipe(
    Schema.check(
      Schema.makeFilter((ids) => new Set(ids).size === ids.length, {
        message: "unique department identifiers",
      }),
    ),
  ),
  sticky: Schema.optional(Schema.Boolean),
});
export type CreateContentDraftCommand = typeof CreateContentDraftCommandSchema.Type;

export const ReviseContentDraftCommandSchema = Schema.Struct({
  commandId: ContentCommandId,
  articleId: ArticleId,
  expectedRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  title: text(255),
  bodyHtml: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value) => value.length <= 100000, {
        message: "an article body within the 100000-byte limit",
      }),
    ),
  ),
  departmentIds: Schema.Array(DepartmentId).pipe(
    Schema.check(
      Schema.makeFilter((ids) => new Set(ids).size === ids.length, {
        message: "unique department identifiers",
      }),
    ),
  ),
  sticky: Schema.optional(Schema.Boolean),
});
export type ReviseContentDraftCommand = typeof ReviseContentDraftCommandSchema.Type;

const ArticleDraftObservationFields = {
  articleId: ArticleId,
  title: text(255),
  slug: ContentWorkspaceEntrySchema.fields.slug,
  bodyHtml: CreateContentDraftCommandSchema.fields.bodyHtml,
  sticky: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  currentVersionNumber: Schema.NullOr(ArticleVersionNumber),
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
};

/** Strict ArticleDraftJson returned only by create. */
export const CreateArticleDraftObservationSchema = Schema.Struct({
  ...ArticleDraftObservationFields,
});
export type CreateArticleDraftObservation = typeof CreateArticleDraftObservationSchema.Type;

/** Strict ArticleDraftJson returned only by revise. */
export const ReviseArticleDraftObservationSchema = Schema.Struct({
  ...ArticleDraftObservationFields,
});
export type ReviseArticleDraftObservation = typeof ReviseArticleDraftObservationSchema.Type;
export const ContentArticleDetailSchema = Schema.Struct({
  articleId: ContentWorkspaceEntrySchema.fields.articleId,
  title: ContentWorkspaceEntrySchema.fields.title,
  slug: ContentWorkspaceEntrySchema.fields.slug,
  status: ContentWorkspaceEntrySchema.fields.status,
  bodyHtml: ArticleDraftObservationFields.bodyHtml,
  sticky: ContentWorkspaceEntrySchema.fields.sticky,
  createdAt: ArticleDraftObservationFields.createdAt,
  updatedAt: ContentWorkspaceEntrySchema.fields.updatedAt,
  currentVersionNumber: ArticleDraftObservationFields.currentVersionNumber,
  revision: ArticleDraftObservationFields.revision,
  departmentIds: ContentWorkspaceEntrySchema.fields.departmentIds,
  canRevise: ContentWorkspaceEntrySchema.fields.canRevise,
  canPublish: ContentWorkspaceEntrySchema.fields.canPublish,
  authorDisplayName: ContentWorkspaceEntrySchema.fields.authorDisplayName,
});
export type ContentArticleDetail = typeof ContentArticleDetailSchema.Type;

export const PublishObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["Published"]),
  commandId: ContentCommandId,
  articleId: ArticleId,
  versionNumber: ArticleVersionNumber,
  publishedAt: Schema.String,
});
export type PublishObservation = typeof PublishObservationSchema.Type;

export const UnpublishObservationSchema = Schema.Struct({
  _tag: Schema.Literals(["Unpublished"]),
  commandId: ContentCommandId,
  articleId: ArticleId,
});
export type UnpublishObservation = typeof UnpublishObservationSchema.Type;

export const PublicationTransitionCommandSchema = Schema.Struct({
  commandId: ContentCommandId,
  articleId: ArticleId,
});
export type PublicationTransitionCommand = typeof PublicationTransitionCommandSchema.Type;
