import {
  ArticleSlug,
  type PublishedNewsArticle,
  type PublishedNewsListing,
} from "@vektorprogrammet/domain/content";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { createHomepageApiClient } from "./api.server";
import {
  applyDepartmentFilter,
  NEWS_TEASER_COUNT,
  resolveDepartmentFilter,
  type NewsDetailData,
  type NewsListingData,
} from "./news";

/**
 * Server-only news loaders (spec 0062 §Homepage public surface contract).
 *
 * Every render performs its own fresh read through createHomepageApiClient();
 * no module-level cache, no build-time snapshot, no loader-shared mutable
 * state. Typed Response throws: 404 for unknown/withdrawn slugs (including a
 * ?versjon miss), 503 for network/decode/persistence failures.
 */

const upstreamFailure = (): Response =>
  new Response("Nyheter er midlertidig utilgjengelig.", { status: 503 });

const notFound = (): Response => new Response("Nyheten finnes ikke.", { status: 404 });

const hasProblemCode = (error: unknown, code: string): error is { readonly code: string } =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const readListing = async (departmentId: string | null): Promise<PublishedNewsListing> => {
  const client = createHomepageApiClient();
  try {
    const result = await client.content.listNews({
      query: departmentId === null ? {} : { department: DepartmentId.make(departmentId) },
      headers: {},
    });
    if (result.body === undefined) throw new Error("The conditional news response has no body.");
    return result.body;
  } catch {
    throw upstreamFailure();
  }
};

export const loadNewsListing = async (departmentSlugOrId?: string): Promise<NewsListingData> => {
  const client = createHomepageApiClient();
  const departments = await client.organization
    .listDepartments({ headers: {} })
    .then((result) => {
      if (result.body === undefined) {
        throw new Error("The conditional department response has no body.");
      }
      return result.body;
    })
    .catch((): readonly never[] => []);
  const { departmentId, degraded } = resolveDepartmentFilter(departments, departmentSlugOrId);
  // One fresh listing read per render; the filter is applied client-side on
  // the already-read snapshot so the teaser and the listing share one read.
  const full = await readListing(null);
  if (degraded) {
    return {
      listing: full,
      notice: { kind: "filter-degraded", departmentId: departmentSlugOrId ?? "" },
    };
  }
  return { listing: applyDepartmentFilter(full, departmentId), notice: null };
};

export const loadNewsTeaser = async (): Promise<PublishedNewsListing> => {
  const listing = await readListing(null);
  return { articles: listing.articles.slice(0, NEWS_TEASER_COUNT) };
};

export const loadNewsArticle = async (
  slug: string,
  versionParam?: string,
): Promise<NewsDetailData> => {
  const client = createHomepageApiClient();
  const version = versionParam === undefined ? undefined : Number(versionParam);
  if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0)) {
    throw notFound();
  }
  try {
    const [articleResult, listingResult] = await Promise.all([
      client.content.readNewsArticle({
        params: { slug: ArticleSlug.make(slug) },
        query: version === undefined ? {} : { version },
        headers: {},
      }),
      client.content.listNews({ query: {}, headers: {} }),
    ]);
    if (articleResult.body === undefined || listingResult.body === undefined) {
      throw new Error("The conditional news response has no body.");
    }
    const article: PublishedNewsArticle = articleResult.body;
    return {
      article,
      otherNews: listingResult.body.articles
        .filter((summary) => summary.slug !== article.slug)
        .slice(0, NEWS_TEASER_COUNT),
    };
  } catch (error) {
    // A draft, withdrawn article, unknown slug, or unknown immutable version
    // is the same plain 404.
    if (hasProblemCode(error, "content.article-not-found")) throw notFound();
    throw upstreamFailure();
  }
};
