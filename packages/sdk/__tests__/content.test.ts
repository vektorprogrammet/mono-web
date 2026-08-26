import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContentArticleDetailSchema,
  ContentWorkspaceSchema,
  CreateArticleDraftObservationSchema,
  CreateContentDraftCommandSchema,
  PublishObservationSchema,
  PublishedNewsArticleSchema,
  ReviseArticleDraftObservationSchema,
  UnpublishObservationSchema,
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

const validDraftObservation = {
  articleId: 7,
  title: "Tittel",
  slug: "tittel",
  bodyHtml: "<p>Brødtekst</p>",
  sticky: false,
  createdAt: "2031-01-01T00:00:00.000Z",
  updatedAt: "2031-01-01T00:01:00.000Z",
  currentVersionNumber: null,
  revision: 0,
};
const validDetail = {
  ...validDraftObservation,
  status: "Draft",
  departmentIds: ["dep-1"],
  canRevise: true,
  canPublish: false,
  authorDisplayName: "Forfatter",
};

const validPublishObservation = {
  _tag: "Published",
  commandId: "publish-1",
  articleId: 7,
  versionNumber: 1,
  publishedAt: "2031-01-01T00:02:00.000Z",
};

const validUnpublishObservation = {
  _tag: "Unpublished",
  commandId: "unpublish-1",
  articleId: 7,
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

  it("uses distinct strict schemas for every mutation observation", () => {
    const observations = [
      [CreateArticleDraftObservationSchema, validDraftObservation],
      [ReviseArticleDraftObservationSchema, { ...validDraftObservation, revision: 1 }],
      [PublishObservationSchema, validPublishObservation],
      [UnpublishObservationSchema, validUnpublishObservation],
    ] as const;

    for (const [schema, observation] of observations) {
      expect(strictDecode(schema as never, observation)).toEqual(observation);
      expect(strictDecode(schema as never, { ...observation, extra: true })).toBeUndefined();
      expect(
        strictDecode(schema as never, { ...observation, "hydra:member": [observation] }),
      ).toBeUndefined();
    }
    const { revision: _, ...missingRevision } = validDraftObservation;
    expect(strictDecode(CreateArticleDraftObservationSchema, missingRevision)).toBeUndefined();
    expect(strictDecode(PublishObservationSchema, validUnpublishObservation)).toBeUndefined();
    expect(strictDecode(UnpublishObservationSchema, validPublishObservation)).toBeUndefined();
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
    expect(strictDecode(ContentArticleDetailSchema, validDetail)).toEqual(validDetail);
    expect(
      strictDecode(ContentArticleDetailSchema, {
        ...validDetail,
        createdByPersonId: "person-9",
      }),
    ).toBeUndefined();
  });
});

describe("content sdk transport", () => {
  it("uses exactly the six frozen 0062.1 staff methods and paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, validWorkspace))
      .mockResolvedValueOnce(response(200, validDetail))
      .mockResolvedValueOnce(response(201, validDraftObservation))
      .mockResolvedValueOnce(response(200, { ...validDraftObservation, revision: 1 }))
      .mockResolvedValueOnce(response(200, validPublishObservation))
      .mockResolvedValueOnce(response(200, validUnpublishObservation));
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

    const results = [
      await client.admin.content.workspace(),
      await client.admin.content.read(7 as never),
      await client.admin.content.createDraft(create as never),
      await client.admin.content.reviseDraft(revise as never),
      await client.admin.content.publish({ commandId: "publish-1", articleId: 7 as never }),
      await client.admin.content.unpublish({ commandId: "unpublish-1", articleId: 7 as never }),
    ];
    expect(results).toEqual([
      validWorkspace,
      validDetail,
      validDraftObservation,
      { ...validDraftObservation, revision: 1 },
      validPublishObservation,
      validUnpublishObservation,
    ]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://api.test/api/admin/content/workspace",
      "http://api.test/api/admin/content/articles/7",
      "http://api.test/api/admin/content/articles",
      "http://api.test/api/admin/content/articles/7",
      "http://api.test/api/admin/content/articles/7/publish",
      "http://api.test/api/admin/content/articles/7/unpublish",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual([
      "GET",
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

  it("preserves every declared Content rejection tag at the Promise boundary", async () => {
    const cases = [
      [401, "UnauthenticatedActor"],
      [403, "AuthorityInactive"],
      [403, "NotInScope"],
      [403, "NotPublisher"],
      [403, "DraftNotOwned"],
      [422, "SlugConflict"],
      [409, "CommandConflict"],
      [404, "ArticleNotFound"],
      [422, "DepartmentNotFound"],
      [422, "ContentDecodeError"],
      [503, "ContentIntegrityError"],
      [503, "ContentPersistenceError"],
    ] as const;

    for (const [status, tag] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(status, { error: { tag } })));
      const client = createClient("http://api.test");
      await expect(client.admin.content.workspace()).rejects.toEqual(
        expect.objectContaining({
          name: ContentRejectionError.name,
          contentTag: tag,
        }),
      );
    }
  });

  it("rejects unknown or polluted failure tags instead of preserving spoof values", async () => {
    for (const body of [
      { error: { tag: "MadeUpContentFailure" } },
      { error: { tag: "NotInScope" }, "hydra:description": "spoof" },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(403, body)));
      const client = createClient("http://api.test");
      await expect(client.admin.content.workspace()).rejects.toEqual(
        expect.objectContaining({
          name: ContentRejectionError.name,
          contentTag: "ContentDecodeError",
        }),
      );
    }
  });

  it("rejects missing, excess, and Hydra mutation responses", async () => {
    for (const body of [
      {},
      { ...validDraftObservation, excess: true },
      { ...validDraftObservation, "hydra:member": [validDraftObservation] },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(201, body)));
      const client = createClient("http://api.test");
      await expect(
        client.admin.content.createDraft({
          commandId: "create-strict",
          title: "Tittel",
          bodyHtml: "<p>Brødtekst</p>",
          departmentIds: [],
        } as never),
      ).rejects.toEqual(
        expect.objectContaining({
          name: ContentRejectionError.name,
          contentTag: "ContentDecodeError",
        }),
      );
    }
  });
});
