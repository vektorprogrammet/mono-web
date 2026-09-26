import { ArticleVersionNumber } from "@vektorprogrammet/http-api";

type NewsApiFixture = {
  listingCalls: number;
  listResult: PublishedNewsListing;
  departments: readonly HomepageDepartment[];
  readArticle: PublishedNewsArticle | { readonly notFound: true } | { readonly networkError: true } | undefined;
  listError: { readonly network: true } | undefined;
};

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleSlug, DepartmentJsonSchema, makeNativeProblem } from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import type { PublishedNewsSummary, HomepageDepartment, PublishedNewsArticle, PublishedNewsListing } from "../src/lib/api-types";

const apiState: NewsApiFixture = { listingCalls: 0, listResult: { articles: [] }, departments: [], readArticle: undefined, listError: undefined };

const publicHeaders = {
  "cache-control": "public, max-age=60, s-maxage=300, must-revalidate",
  vary: "Origin",
  etag: '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
};

beforeEach(() => {
  vi.stubEnv("API_URL", "http://api.test");

  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.pathname === "/api/departments") return Response.json(apiState.departments, { headers: publicHeaders });

    if (url.pathname === "/api/news") {
      if (apiState.listError !== undefined) throw new TypeError("Network unavailable");
      apiState.listingCalls += 1;

      return Response.json(apiState.listResult, { headers: publicHeaders });
    }

    const article = apiState.readArticle;

    if (article === undefined || "notFound" in article || url.searchParams.get("version") === "99") {
      return Response.json(makeNativeProblem("content.article-not-found", 404), {
        status: 404, headers: { "cache-control": "no-store", vary: "Origin" },
      });
    }

    if ("networkError" in article) throw new TypeError("Network unavailable");

    return Response.json(url.searchParams.get("version") === "1" ? { ...article, bodyHtml: "<p>eldre, uforanderlige bytes</p>" } : article, { headers: publicHeaders });
  };

  vi.stubGlobal("fetch", fetch);
});


import { loadNewsArticle, loadNewsListing, loadNewsTeaser } from "../src/lib/news.server";
import {
  applyDepartmentFilter,
  paginateNewsListing,
  resolveDepartmentFilter,
} from "../src/lib/news";

interface NewsSummaryOverrides extends Omit<Partial<PublishedNewsSummary>, "slug" | "departmentIds"> {
  readonly slug?: string;
  readonly departmentIds?: readonly string[];
}

const summary = (overrides: NewsSummaryOverrides = {}): PublishedNewsSummary => ({
  title: "Første nyhet", sticky: false, publishedAt: "2031-05-01T00:00:00.000Z", authorDisplayName: "Ada Administrator", hasImage: false,
  ...overrides,
  slug: ArticleSlug.make(overrides.slug ?? "forste-nyhet"),
  departmentIds: (overrides.departmentIds ?? ["department-a"]).map((id) => DepartmentJsonSchema.fields.departmentId.make(id)),
});

afterEach(() => {
  apiState.listingCalls = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  apiState.listError = undefined;
  apiState.readArticle = undefined;
});

describe("news loaders", () => {
  it("performs a fresh read per render — two calls hit the API twice", async () => {
    apiState.listResult = { articles: [summary()] };
    await loadNewsListing();
    expect(apiState.listingCalls).toBe(1);
    await loadNewsListing();
    expect(apiState.listingCalls).toBe(2);
  });

  it("teaser slices the first five summaries of the same single read", async () => {
    apiState.listResult = {
      articles: [summary({ sticky: true }), {}, {}, {}, {}, {}, {}].map((base, index) =>
        summary({ slug: `nyhet-${index}`, title: `Nyhet ${index}`, ...base }),
      ),
    };
    const teaser = await loadNewsTeaser();
    expect(teaser.articles).toHaveLength(5);
    expect(apiState.listingCalls).toBe(1);
  });

  it("maps an unknown or withdrawn slug to a plain 404", async () => {
    apiState.readArticle = { notFound: true };
    await expect(loadNewsArticle("finnes-ikke")).rejects.toMatchObject({ status: 404 });
    // A version miss on a known slug is also a plain 404.
    apiState.readArticle = {
      slug: ArticleSlug.make("nyhet"),
      title: "Nyhet",
      sticky: false,
      publishedAt: "2031-05-01T00:00:00.000Z",
      authorDisplayName: "A",
      departmentIds: [],
      hasImage: false,
      bodyHtml: "<p>x</p>",
      previousVersions: [
        {
          versionNumber: ArticleVersionNumber.make(1),
          publishedAt: "2031-01-01T00:00:00.000Z",
          urlPath: "/nyhet/nyhet?versjon=1",
        },
      ],
    };
    await expect(loadNewsArticle("nyhet", "99")).rejects.toMatchObject({ status: 404 });
    await expect(loadNewsArticle("nyhet", "1")).resolves.toMatchObject({
      article: { bodyHtml: "<p>eldre, uforanderlige bytes</p>" },
    });
  });

  it("maps upstream network/decode/persistence failures to 503", async () => {
    apiState.listError = { network: true };
    await expect(loadNewsListing()).rejects.toMatchObject({ status: 503 });
    apiState.readArticle = { networkError: true };
    await expect(loadNewsArticle("nyhet")).rejects.toMatchObject({ status: 503 });
  });

  it("degrades a vanished department filter to the unfiltered listing with a notice", () => {
    const departments = [Schema.decodeSync(DepartmentJsonSchema)({ departmentId: "department-a", name: "Alfa", shortName: "ALFA", email: "alfa@example.test", address: "A 1", city: "Trondheim", latitude: "0", longitude: "0", slackChannel: null, logoPath: null, active: true, revision: 0 })];
    const resolvedKnown = resolveDepartmentFilter(departments, "ALFA");
    expect(resolvedKnown).toEqual({ departmentId: "department-a", degraded: false });

    const resolvedVanished = resolveDepartmentFilter(departments, "borte");
    expect(resolvedVanished.degraded).toBe(true);

    const listing = {
      articles: [
        summary({ slug: "department", departmentIds: ["department-a"] }),
        summary({ slug: "organization", departmentIds: [] }),
        summary({ slug: "other", departmentIds: ["department-b"] }),
      ],
    };

    const filtered = applyDepartmentFilter(listing, DepartmentJsonSchema.fields.departmentId.make("department-a"));
    expect(filtered.articles.map((article) => article.slug)).toEqual([
      "department",
      "organization",
    ]);
  });

  it("paginates the fully loaded listing in pure pages of ten", () => {
    const listing = {
      articles: Array.from({ length: 21 }, (_, index) => summary({ slug: `nyhet-${index}` })),
    };

    expect(paginateNewsListing(listing, 2).articles.map((article) => article.slug)).toEqual(
      Array.from({ length: 10 }, (_, index) => `nyhet-${index + 10}`),
    );
    expect(paginateNewsListing(listing, 3).articles.map((article) => article.slug)).toEqual([
      "nyhet-20",
    ]);
  });

  it("loads one other-news listing for a detail render", async () => {
    apiState.readArticle = {
      ...summary({ slug: "current" }),
      bodyHtml: "<p>current</p>",
      previousVersions: [],
    };
    apiState.listResult = {
      articles: [summary({ slug: "current" }), summary({ slug: "other" })],
    };

    await expect(loadNewsArticle("current")).resolves.toMatchObject({
      otherNews: [{ slug: "other" }],
    });
    expect(apiState.listingCalls).toBe(1);
  });
});
