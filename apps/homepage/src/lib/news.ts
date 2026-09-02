import type {
  ContentWorkspace,
  PublishedNewsArticle,
  PublishedNewsListing,
  PublishedNewsSummary,
} from "@vektorprogrammet/domain/content";
import type { DepartmentJson } from "@vektorprogrammet/domain/organization";

/**
 * News data seam for the homepage loaders (spec 0062 §Homepage public surface
 * contract). Everything here is derived from one fresh listing read per
 * render; there is no module-level cache and no fixture fallback.
 */

export type NewsNotice = { readonly kind: "filter-degraded"; readonly departmentId: string };

export interface NewsListingData {
  readonly listing: PublishedNewsListing;
  /** Set when a requested department vanished between the two reads. */
  readonly notice: NewsNotice | null;
}

export interface NewsDetailData {
  readonly article: PublishedNewsArticle;
  readonly otherNews: readonly PublishedNewsSummary[];
}

export const NEWS_TEASER_COUNT = 5;
export const NEWS_PAGE_SIZE = 10;

/** Sticky-first first-five slice of the SAME listing read (law: teaser). */
export const teaserFrom = (listing: PublishedNewsListing): readonly PublishedNewsSummary[] =>
  listing.articles.slice(0, NEWS_TEASER_COUNT);

/**
 * Resolves a visitor-facing department selection to an id through the
 * already-native public departments read. An id that vanishes between reads
 * degrades to the unfiltered listing with a visible notice — never to
 * fabricated rows.
 */
export const resolveDepartmentFilter = (
  departments: readonly DepartmentJson[],
  departmentSlugOrId: string | undefined,
): { readonly departmentId: string | null; readonly degraded: boolean } => {
  if (departmentSlugOrId === undefined || departmentSlugOrId === "") {
    return { departmentId: null, degraded: false };
  }
  const direct = departments.find(
    (department) => department.departmentId === departmentSlugOrId && department.active,
  );
  if (direct !== undefined) return { departmentId: direct.departmentId, degraded: false };
  const byShortName = departments.find(
    (department) =>
      department.active &&
      department.shortName.trim().toLowerCase() === departmentSlugOrId.trim().toLowerCase(),
  );
  if (byShortName !== undefined) {
    return { departmentId: byShortName.departmentId, degraded: false };
  }
  return { departmentId: null, degraded: true };
};

/** Client-side filter of the already-read listing (never a second read). */
export const applyDepartmentFilter = (
  listing: PublishedNewsListing,
  departmentId: string | null,
): PublishedNewsListing =>
  departmentId === null
    ? listing
    : {
        articles: listing.articles.filter(
          (article) =>
            article.departmentIds.length === 0 ||
            article.departmentIds.includes(departmentId as never),
        ),
      };

export const paginateNewsListing = (
  listing: PublishedNewsListing,
  page: number,
): PublishedNewsListing => ({
  articles: listing.articles.slice((page - 1) * NEWS_PAGE_SIZE, page * NEWS_PAGE_SIZE),
});

export type { ContentWorkspace };
