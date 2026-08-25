import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ContentWorkspaceSchema,
  CreateContentDraftCommandSchema,
  PublishedNewsArticleSchema,
} from "../src/schemas/content.js";

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
