import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentRejectionError } from "@vektorprogrammet/sdk";

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
    public: {
      news: {
        list: async () => {
          if (mocks.listError !== undefined) {
            throw new (class extends Error {
              readonly type = "network";
            })("network down");
          }
          mocks.bumpListing();
          return mocks.listResult;
        },
        read: async (slug: string, input?: { readonly version?: number }) => {
          const article = mocks.readArticle;
          if (
            article === undefined ||
            ("notFound" in article && article.notFound) ||
            input?.version === 99
          ) {
            throw new ContentRejectionError("ArticleNotFound");
          }
          if ("networkError" in article && article.networkError) {
            throw new (class extends Error {
              readonly type = "network";
            })("network down");
          }
          return input?.version === 1
            ? { ...article, bodyHtml: "<p>eldre, uforanderlige bytes</p>" }
            : article;
        },
      },
      organization: {
        listDepartments: async () => mocks.departments,
      },
    },
  }),
}));

import { loadNewsArticle, loadNewsListing, loadNewsTeaser } from "../src/lib/news.server";
import {
  applyDepartmentFilter,
  isBodySafeForRender,
  resolveDepartmentFilter,
  stripUnsafeBody,
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

    const listing = { articles: [summary({ departmentIds: ["department-a"] })] } as never;
    const filtered = applyDepartmentFilter(listing, "department-a");
    expect(filtered.articles).toHaveLength(1);
  });
});

describe("render-time body defense", () => {
  it("refuses script and iframe payloads", () => {
    expect(isBodySafeForRender("<p>trygg tekst</p>")).toBe(true);
    expect(isBodySafeForRender("<script>alert(1)</script>")).toBe(false);
    expect(isBodySafeForRender('<iframe src="https://evil.example"></iframe>')).toBe(false);
    expect(isBodySafeForRender("<img src=x onerror=alert(1)>")).toBe(false);
    expect(isBodySafeForRender("javascript:void(0)")).toBe(false);
  });

  it("strips unsafe bytes instead of rendering them", () => {
    const stripped = stripUnsafeBody("<script>alert(1)</script><p>beholdes</p>");
    expect(stripped).not.toContain("script");
    expect(stripped).toContain("beholdes");
  });
});
