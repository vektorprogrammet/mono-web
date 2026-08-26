import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContentWorkspaceSchema,
  CreateContentDraftCommandSchema,
  PublishedNewsArticleSchema,
} from "../src/schemas/content.js";
import { ContentRejectionError, createClient } from "../src/promise.js";

const strictDecode = <A>(
  schema: Schema.Schema<A, unknown, never>,
  input: unknown,
): A | undefined => {
  try {
    return Schema.decodeUnknownSync(schema)(input, { onExcessProperty: "error" });
  } catch {
    return undefined;
  }
};

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const validWorkspace = {
  entries: [
    {
      articleId: 1,
      title: "Tittel",
      slug: "tittel",
      status: "Draft",
      sticky: false,
      updatedAt: "2031-01-01T00:00:00.000Z",
      departmentIds: ["dep-1"],
      canRevise: true,
      canPublish: false,
      authorDisplayName: "Forfatter",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});
describe("content sdk schemas", () => {
  it("decodes the exact workspace shape", () => {
    expect(strictDecode(ContentWorkspaceSchema, validWorkspace)).toEqual(validWorkspace);
  });

  it("rejects excess properties on workspace rows", () => {
    const polluted = {
      ...validWorkspace,
      entries: [{ ...validWorkspace.entries[0], hydra_view: "http://hydra" }],
    };
    expect(strictDecode(ContentWorkspaceSchema, polluted)).toBeUndefined();
  });

  it("rejects Hydra envelopes and page walkers", () => {
    expect(
      strictDecode(ContentWorkspaceSchema, { ...validWorkspace, "hydra:totalItems": 1 }),
    ).toBeUndefined();
    expect(strictDecode(ContentWorkspaceSchema, { ...validWorkspace, view: {} })).toBeUndefined();
  });

  it("rejects a non-slug slug grammar", () => {
    const bad = { ...validWorkspace, entries: [{ ...validWorkspace.entries[0]!, slug: "Kladd!" }] };
    expect(strictDecode(ContentWorkspaceSchema, bad)).toBeUndefined();
  });

  it("round-trips a create draft command strictly", () => {
    const command = {
      commandId: "cmd-1",
      title: "Tittel",
      bodyHtml: "<p>Brødtekst</p>",
      departmentIds: ["dep-1"],
    };
    const encoded = Schema.encodeSync(CreateContentDraftCommandSchema)(command);
    expect(encoded).toEqual(command);
    expect(
      strictDecode(CreateContentDraftCommandSchema, { ...encoded, extra: true }),
    ).toBeUndefined();
  });

  it("decodes the public article with previous versions", () => {
    const article = {
      slug: "nyhet",
      title: "Nyhet",
      sticky: true,
      publishedAt: "2031-02-03T04:05:06.000Z",
      authorDisplayName: "Forfatter",
      departmentIds: [],
      hasImage: false,
      bodyHtml: "<p>Innhold</p>",
      previousVersions: [
        {
          versionNumber: 2,
          publishedAt: "2031-02-01T00:00:00.000Z",
          urlPath: "/nyhet/nyhet?versjon=2",
        },
        {
          versionNumber: 1,
          publishedAt: "2031-01-01T00:00:00.000Z",
          urlPath: "/nyhet/nyhet?versjon=1",
        },
      ],
    };
    expect(strictDecode(PublishedNewsArticleSchema, article)).toEqual(article);
    expect(
      strictDecode(PublishedNewsArticleSchema, { ...article, createdByPersonId: "secret" }),
    ).toBeUndefined();
  });

  it("keeps private person ids out of every decoded payload", () => {
    const leaked = {
      ...validWorkspace,
      entries: [{ ...validWorkspace.entries[0], createdByPersonId: "person-9" }],
    };
    expect(strictDecode(ContentWorkspaceSchema, leaked)).toBeUndefined();
  });
});

describe("content sdk transport", () => {
  it("uses exactly the five frozen staff methods and paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, validWorkspace))
      .mockResolvedValueOnce(response(201, {}))
      .mockResolvedValueOnce(response(200, {}))
      .mockResolvedValueOnce(response(200, {}))
      .mockResolvedValueOnce(response(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test", {
      cookie: "better-auth.session_token=content-session",
    });
    const create = {
      commandId: "create-1",
      title: "Tittel",
      bodyHtml: "<p>Brødtekst</p>",
      departmentIds: ["dep-1"],
    };
    const revise = {
      ...create,
      commandId: "revise-1",
      articleId: 7,
      expectedRevision: 0,
      sticky: false,
    };

    await client.admin.content.workspace();
    await client.admin.content.createDraft(create as never);
    await client.admin.content.reviseDraft(revise as never);
    await client.admin.content.publish({ commandId: "publish-1", articleId: 7 as never });
    await client.admin.content.unpublish({ commandId: "unpublish-1", articleId: 7 as never });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://api.test/api/admin/content/workspace",
      "http://api.test/api/admin/content/drafts",
      "http://api.test/api/admin/content/articles/7",
      "http://api.test/api/admin/content/articles/7/publish",
      "http://api.test/api/admin/content/articles/7/unpublish",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual([
      "GET",
      "POST",
      "PUT",
      "POST",
      "POST",
    ]);
  });

  it("serializes the public department filter on the frozen news endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200, { articles: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("http://api.test");

    await client.public.news.list({ department: "department-a" as never });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://api.test/api/news?department=department-a",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual(["GET"]);
  });

  it("preserves typed Content denial tags at the Promise boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(response(403, { error: { tag: "AuthorityInactive" } })),
    );
    const client = createClient("http://api.test");

    await expect(client.admin.content.workspace()).rejects.toEqual(
      expect.objectContaining({
        name: ContentRejectionError.name,
        contentTag: "AuthorityInactive",
      }),
    );
  });
});
