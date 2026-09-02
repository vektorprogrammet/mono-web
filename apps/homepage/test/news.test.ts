import { afterEach, describe, expect, it, vi } from "vitest";
const articleNotFoundProblem = {
  type: "urn:vektorprogrammet:problem:v0.2:content.article-not-found",
  title: "Article not found",
  status: 404,
  code: "content.article-not-found",
  detail: "The requested article does not exist.",
} as const;

const mocks = vi.hoisted(() => {
  let listingCalls = 0;
  return {
    get listingCalls() {
      return listingCalls;
    },
    bumpListing: () => {
      listingCalls += 1;
    },
    reset: () => {
      listingCalls = 0;
    },
    listResult: { articles: [] as Array<Record<string, unknown>> },
    departments: [] as Array<Record<string, unknown>>,
    readArticle: undefined as
      | Record<string, unknown>
      | { readonly notFound: true }
      | { readonly networkError: true }
      | undefined,
    listError: undefined as { readonly network: true } | undefined,
  };
});

vi.mock("../src/lib/api.server", () => ({
  createHomepageApiClient: () => ({
    content: {
      listNews: async () => {
        if (mocks.listError !== undefined) {
          throw new (class extends Error {
            readonly type = "network";
          })("network down");
        }
        mocks.bumpListing();
        return { body: mocks.listResult, headers: {} };
      },
      readNewsArticle: async (input: {
        readonly params: { readonly slug: string };
        readonly query: { readonly version?: number };
        readonly headers: object;
      }) => {
        const article = mocks.readArticle;
        if (
          article === undefined ||
          ("notFound" in article && article.notFound) ||
          input.query.version === 99
        ) {
          throw articleNotFoundProblem;
        }
        if ("networkError" in article && article.networkError) {
          throw new (class extends Error {
            readonly type = "network";
          })("network down");
        }
        return {
          body:
            input.query.version === 1
              ? { ...article, bodyHtml: "<p>eldre, uforanderlige bytes</p>" }
              : article,
          headers: {},
        };
      },
    },
    organization: {
      listDepartments: async () => ({
        body: mocks.departments,
        headers: {},
      }),
    },
  }),
}));

import { loadNewsArticle, loadNewsListing, loadNewsTeaser } from "../src/lib/news.server";
import {
  applyDepartmentFilter,
  paginateNewsListing,
  resolveDepartmentFilter,
} from "../src/lib/news";

const summary = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "forste-nyhet",
  title: "Første nyhet",
  sticky: false,
  publishedAt: "2031-05-01T00:00:00.000Z",
  authorDisplayName: "Ada Administrator",
  departmentIds: ["department-a"],
  hasImage: false,
  ...overrides,
});

afterEach(() => {
  mocks.reset();
  mocks.listError = undefined;
  mocks.readArticle = undefined;
});

describe("news loaders", () => {
  it("performs a fresh read per render — two calls hit the API twice", async () => {
    mocks.listResult = { articles: [summary()] };
    await loadNewsListing();
    expect(mocks.listingCalls).toBe(1);
    await loadNewsListing();
    expect(mocks.listingCalls).toBe(2);
  });

  it("teaser slices the first five summaries of the same single read", async () => {
    mocks.listResult = {
      articles: [summary({ sticky: true }), {}, {}, {}, {}, {}, {}].map((base, index) =>
        summary({ slug: `nyhet-${index}`, title: `Nyhet ${index}`, ...base }),
      ),
    };
    const teaser = await loadNewsTeaser();
    expect(teaser.articles).toHaveLength(5);
    expect(mocks.listingCalls).toBe(1);
  });

  it("maps an unknown or withdrawn slug to a plain 404", async () => {
    mocks.readArticle = { notFound: true } as never;
    await expect(loadNewsArticle("finnes-ikke")).rejects.toMatchObject({ status: 404 });
    // A version miss on a known slug is also a plain 404.
    mocks.readArticle = {
      slug: "nyhet",
      title: "Nyhet",
      sticky: false,
      publishedAt: "2031-05-01T00:00:00.000Z",
      authorDisplayName: "A",
      departmentIds: [],
      hasImage: false,
      bodyHtml: "<p>x</p>",
      previousVersions: [
        {
          versionNumber: 1,
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
    mocks.listError = { network: true };
    await expect(loadNewsListing()).rejects.toMatchObject({ status: 503 });
    mocks.readArticle = { networkError: true } as never;
    await expect(loadNewsArticle("nyhet")).rejects.toMatchObject({ status: 503 });
  });

  it("degrades a vanished department filter to the unfiltered listing with a notice", () => {
    const departments = [{ departmentId: "department-a", shortName: "ALFA", active: true }];
    const resolvedKnown = resolveDepartmentFilter(departments as never, "ALFA");
    expect(resolvedKnown).toEqual({ departmentId: "department-a", degraded: false });

    const resolvedVanished = resolveDepartmentFilter(departments as never, "borte");
    expect(resolvedVanished.degraded).toBe(true);

    const listing = {
      articles: [
        summary({ slug: "department", departmentIds: ["department-a"] }),
        summary({ slug: "organization", departmentIds: [] }),
        summary({ slug: "other", departmentIds: ["department-b"] }),
      ],
    } as never;
    const filtered = applyDepartmentFilter(listing, "department-a");
    expect(filtered.articles.map((article) => article.slug)).toEqual([
      "department",
      "organization",
    ]);
  });

  it("paginates the fully loaded listing in pure pages of ten", () => {
    const listing = {
      articles: Array.from({ length: 21 }, (_, index) => summary({ slug: `nyhet-${index}` })),
    } as never;
    expect(paginateNewsListing(listing, 2).articles.map((article) => article.slug)).toEqual(
      Array.from({ length: 10 }, (_, index) => `nyhet-${index + 10}`),
    );
    expect(paginateNewsListing(listing, 3).articles.map((article) => article.slug)).toEqual([
      "nyhet-20",
    ]);
  });

  it("loads one other-news listing for a detail render", async () => {
    mocks.readArticle = {
      ...summary({ slug: "current" }),
      bodyHtml: "<p>current</p>",
      previousVersions: [],
    };
    mocks.listResult = {
      articles: [summary({ slug: "current" }), summary({ slug: "other" })],
    };

    await expect(loadNewsArticle("current")).resolves.toMatchObject({
      otherNews: [{ slug: "other" }],
    });
    expect(mocks.listingCalls).toBe(1);
  });
});
