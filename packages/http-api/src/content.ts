/**
 * Public HTTP contracts for staff content and published news.
 *
 * @since 0.1.0
 */
import {
  ArticleVersionNumber,
  ArticleId,
  ArticleSlug,
  ContentWorkspaceSchema,
  PublishedNewsArticleSchema,
  PublishedNewsListingSchema,
  type ContentWorkspace,
} from "@vektorprogrammet/domain/content";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";

export { ArticleVersionNumber, ArticleId, ArticleSlug, ContentWorkspaceSchema };

export type { ContentWorkspace };

/**
 * Optional public/staff department filter using the transport key.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const ContentDepartmentQuery = Schema.Struct({
  department: Schema.optional(DepartmentId),
});

/**
 * Optional positive published-version selector.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const NewsVersionQuery = Schema.Struct({
  version: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
});

/** The article identity carried by the staff detail and mutation routes. */
export const ContentArticleParams = Schema.Struct({ articleId: ArticleId });

/** The slug identity carried by the public article route. */
export const ContentNewsSlugParams = Schema.Struct({ slug: ArticleSlug });

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

/** The annotated public listing representation used by 200 and its conditional contract. */
export const PublishedNewsListingResponse = PublishedNewsListingSchema.annotate({
  identifier: "PublishedNewsListing",
  description: "Current public news listing.",
  examples: [NewsListingExample],
});

/** The annotated public article representation used by 200 and its conditional contract. */
export const PublishedNewsArticleResponse = PublishedNewsArticleSchema.annotate({
  identifier: "PublishedNewsArticle",
  description: "One published news article.",
  examples: [NewsArticleExample],
});
