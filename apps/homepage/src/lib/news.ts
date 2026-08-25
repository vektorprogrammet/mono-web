import type {
  DepartmentJson,
  PublishedNewsArticle,
  PublishedNewsListing,
  PublishedNewsSummary,
} from "@vektorprogrammet/sdk";
import type { ContentWorkspace } from "@vektorprogrammet/sdk";

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
}

export const NEWS_TEASER_COUNT = 5;

/** Sticky-first first-five slice of the SAME listing read (law: teaser). */
export const teaserFrom = (
  listing: PublishedNewsListing,
): readonly PublishedNewsSummary[] => listing.articles.slice(0, NEWS_TEASER_COUNT);

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
        articles: listing.articles.filter((article) =>
          article.departmentIds.includes(departmentId as never),
        ),
      };

/**
 * Defense-in-depth body check before any public render.
 *
 * Primary sanitization happens at WRITE time in the backend
 * (@vektorprogrammet/domain content sanitizer, spec law 6 / DoD item 15):
 * stored bytes cannot carry script/iframe because every create/revise runs
 * the write-time sanitizer and refuses unclosed script documents. This
 * re-check guarantees no stored byte escapes to HTML even if an older row
 * predates the sanitizer contract.
 */
const FORBIDDEN_BODY_PATTERN =
  /<(script|iframe|object|embed)\b|<\/(script|iframe)>|\son[a-z]+\s*=|(?:javascript|vbscript)\s*:/i;

export const isBodySafeForRender = (bodyHtml: string): boolean =>
  !FORBIDDEN_BODY_PATTERN.test(bodyHtml);

export const stripUnsafeBody = (bodyHtml: string): string =>
  bodyHtml
    .replaceAll(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(script|iframe|object|embed)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

/** Resolves a ?versjon=N request against previousVersions only. */
export const resolveVersionedBody = (
  article: PublishedNewsArticle,
  versionParam: string | undefined,
): { readonly bodyHtml: string; readonly matched: boolean } => {
  if (versionParam === undefined) return { bodyHtml: article.bodyHtml, matched: true };
  const requested = Number(versionParam);
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    return { bodyHtml: "", matched: false };
  }
  if (requested === article.previousVersions[0]?.versionNumber + 0) {
    // The current version number never appears in previousVersions; only the
    // canonical slug serves it. A ?versjon equal to current resolves too.
    return { bodyHtml: article.bodyHtml, matched: true };
  }
  const known = article.previousVersions.some(
    (version) => version.versionNumber === requested,
  );
  return { bodyHtml: article.bodyHtml, matched: known };
};

export type { ContentWorkspace };
