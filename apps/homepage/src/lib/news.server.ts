import { ArticleSlug, isProblem } from "@vektorprogrammet/rpc";
import type { PublishedNewsListing } from "./api-types";
import { callHomepageNative } from "./api.server";
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
 * Every render performs its own fresh read through callHomepageNative();
 * no module-level cache, no build-time snapshot, no loader-shared mutable
 * state. Typed Response throws: 404 for unknown/withdrawn slugs (including a
 * ?versjon miss), 503 for network/decode/persistence failures.
 */

const upstreamFailure = (): Response =>
  new Response("Nyheter er midlertidig utilgjengelig.", { status: 503 });

const notFound = (): Response => new Response("Nyheten finnes ikke.", { status: 404 });

const readListing = async (): Promise<PublishedNewsListing> => {
  try {
    return await callHomepageNative((client) => client["content.listNews"]({}));
  } catch {
    throw upstreamFailure();
  }
};

export const loadNewsListing = async (departmentSlugOrId?: string): Promise<NewsListingData> => {
  const departments = await callHomepageNative((client) =>
    client["organization.listDepartments"](),
  ).catch((): readonly never[] => []);

  const { departmentId, degraded } = resolveDepartmentFilter(departments, departmentSlugOrId);
  // One fresh listing read per render; the filter is applied client-side on
  // the already-read snapshot so the teaser and the listing share one read.
  const full = await readListing();

  if (degraded) {
    return {
      listing: full,
      notice: { kind: "filter-degraded", departmentId: departmentSlugOrId ?? "" },
    };
  }

  return { listing: applyDepartmentFilter(full, departmentId), notice: null };
};

export const loadNewsTeaser = async (): Promise<PublishedNewsListing> => {
  const listing = await readListing();

  return { articles: listing.articles.slice(0, NEWS_TEASER_COUNT) };
};

export const loadNewsArticle = async (
  slug: string,
  versionParam?: string,
): Promise<NewsDetailData> => {
  const version = versionParam === undefined ? undefined : Number(versionParam);

  if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0)) {
    throw notFound();
  }

  try {
    const articleSlug = ArticleSlug.make(slug);
    const query = version === undefined ? { slug: articleSlug } : { slug: articleSlug, version };

    const [article, listing] = await Promise.all([
      callHomepageNative((client) => client["content.readNewsArticle"](query)),
      callHomepageNative((client) => client["content.listNews"]({})),
    ]);

    return {
      article,
      otherNews: listing.articles
        .filter((summary) => summary.slug !== article.slug)
        .slice(0, NEWS_TEASER_COUNT),
    };
  } catch (error) {
    if (isProblem(error) && error.code === "content.article-not-found") throw notFound();
    throw upstreamFailure();
  }
};
