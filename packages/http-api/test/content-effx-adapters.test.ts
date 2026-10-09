/**
 * EX-0022: required public native APIs in exact stable Effect4 retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import {
  Capability,
  Concealment,
  type HttpAccessAnnotationSpec,
  type ProblemRegistry,
} from "@effx/runtime";
import { Context, Option, Result, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";
import { AccessSpecAnnotation, reflectAccessSpec } from "../src/access.js";
import { ExternalNativeApi } from "../src/api.js";
import { PersonSecurity } from "../src/common.js";
import {
  ContentArticlesResolver,
  ContentArticleByIdResolver,
  ContentArticleCreateResolver,
  ContentPublicNewsBySlugResolver,
  ContentPublicNewsResolver,
  contentAccessAnnotations,
} from "../src/content-effx-adapters.js";
import {
  ContentArticleParams,
  ContentDepartmentQuery,
  ContentNewsSlugParams,
  NewsArticleExample,
  NewsListingExample,
  NewsVersionQuery,
  PublishedNewsArticleResponse,
  PublishedNewsListingResponse,
} from "../src/content.js";
import {
  createArticle,
  listNews,
  publishArticle,
  readArticle,
  readContentWorkspace,
  readNewsArticle,
  reviseArticle,
  unpublishArticle,
} from "../.effx/generated/content-contract.js";
import {
  ContentCreateArticleCodes,
  ContentCreateArticleProblem,
  ContentListNewsCodes,
  ContentListNewsProblem,
  ContentPublishArticleCodes,
  ContentPublishArticleProblem,
  ContentReadArticleCodes,
  ContentReadArticleProblem,
  ContentReadContentWorkspaceCodes,
  ContentReadContentWorkspaceProblem,
  ContentReadNewsArticleCodes,
  ContentReadNewsArticleProblem,
  ContentReviseArticleCodes,
  ContentReviseArticleProblem,
  ContentUnpublishArticleCodes,
  ContentUnpublishArticleProblem,
  nativeProblems,
} from "../src/endpoint-problems.js";
import {
  NativeProblemRegistry,
  ProfileReadResponseHeaders,
  PublicConditionalResponseHeaders,
  privateConditionalResponses,
  publicConditionalResponses,
} from "../src/http-semantics.js";

const staffCases = [
  {
    endpoint: readContentWorkspace,
    capability: "content.read-workspace",
    resolver: ContentArticlesResolver,
    requirements: [],
    time: "SnapshotRead",
  },
  {
    endpoint: createArticle,
    capability: "content.create-article",
    resolver: ContentArticleCreateResolver,
    requirements: [],
    time: "Transaction",
  },
  {
    endpoint: readArticle,
    capability: "content.read-article",
    resolver: ContentArticleByIdResolver,
    requirements: [],
    time: "SnapshotRead",
  },
  {
    endpoint: reviseArticle,
    capability: "content.revise-article",
    resolver: ContentArticleByIdResolver,
    requirements: ["content.revisable"],
    time: "Transaction",
  },
  {
    endpoint: publishArticle,
    capability: "content.publish-article",
    resolver: ContentArticleByIdResolver,
    requirements: ["content.publishable"],
    time: "Transaction",
  },
  {
    endpoint: unpublishArticle,
    capability: "content.publish-article",
    resolver: ContentArticleByIdResolver,
    requirements: ["content.unpublishable"],
    time: "Transaction",
  },
] as const;

const publicCases = [
  { endpoint: listNews, resolver: ContentPublicNewsResolver },
  { endpoint: readNewsArticle, resolver: ContentPublicNewsBySlugResolver },
] as const;

type ContentResolverSymbol =
  | (typeof staffCases)[number]["resolver"]
  | (typeof publicCases)[number]["resolver"];

const staffAccess = (
  capability: string,
  resolver: ContentResolverSymbol,
  requirements: ReadonlyArray<string>,
  time: "SnapshotRead" | "Transaction",
): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
  principalKinds: ["Person"],
  capabilities: Capability.one(capability),
  requirements: requirements.map((id) => ({ id })),
  canonicalScopeResolver: resolver,
  concealment: Concealment.reveal,
  decisionTime: time,
});

const publicAccess = (resolver: ContentResolverSymbol): HttpAccessAnnotationSpec => ({
  exposure: "External",
  acceptedCredentials: ["None"],
  principalKinds: ["Anonymous"],
  capabilities: Capability.none,
  requirements: [],
  canonicalScopeResolver: resolver,
  concealment: Concealment.reveal,
  decisionTime: "SnapshotRead",
});

const problemCases = [
  [
    readContentWorkspace,
    ContentReadContentWorkspaceCodes,
    ContentReadContentWorkspaceProblem,
    "ContentReadContentWorkspaceProblem",
  ],
  [
    createArticle,
    ContentCreateArticleCodes,
    ContentCreateArticleProblem,
    "ContentCreateArticleProblem",
  ],
  [readArticle, ContentReadArticleCodes, ContentReadArticleProblem, "ContentReadArticleProblem"],
  [
    reviseArticle,
    ContentReviseArticleCodes,
    ContentReviseArticleProblem,
    "ContentReviseArticleProblem",
  ],
  [
    publishArticle,
    ContentPublishArticleCodes,
    ContentPublishArticleProblem,
    "ContentPublishArticleProblem",
  ],
  [
    unpublishArticle,
    ContentUnpublishArticleCodes,
    ContentUnpublishArticleProblem,
    "ContentUnpublishArticleProblem",
  ],
  [listNews, ContentListNewsCodes, ContentListNewsProblem, "ContentListNewsProblem"],
  [
    readNewsArticle,
    ContentReadNewsArticleCodes,
    ContentReadNewsArticleProblem,
    "ContentReadNewsArticleProblem",
  ],
] as const;

describe("generated Content contract", () => {
  it("reuses actual Struct query and route parameter schemas on generated endpoints", () => {
    expect(Schema.decodeResult(ContentDepartmentQuery)({})).toEqual(Result.succeed({}));
    expect(Schema.decodeResult(ContentDepartmentQuery)({ department: "1" })).toEqual(
      Result.succeed({ department: "1" }),
    );
    expect(Schema.decodeResult(NewsVersionQuery)({ version: 1 })).toEqual(
      Result.succeed({ version: 1 }),
    );
    expect(Result.isFailure(Schema.decodeResult(NewsVersionQuery)({ version: 0 }))).toBe(true);
    expect(Schema.decodeResult(ContentArticleParams)({ articleId: 1 })).toEqual(
      Result.succeed({ articleId: 1 }),
    );
    expect(Schema.decodeResult(ContentNewsSlugParams)({ slug: "penerimaan-anggota-2026" })).toEqual(
      Result.succeed({ slug: "penerimaan-anggota-2026" }),
    );

    expect(readContentWorkspace.query).toBeDefined();
    expect(listNews.query).toBeDefined();
    expect(readNewsArticle.query).toBeDefined();
    // HttpApiEndpoint normalizes query and path schemas to string-tree codecs;
    // their object identity is intentionally not the identity of the input Struct.
    const spec = OpenApi.fromApi(ExternalNativeApi);

    for (const [operation, name] of [
      [spec.paths["/api/content/articles"]?.get, "department"],
      [spec.paths["/api/news"]?.get, "department"],
      [spec.paths["/api/news/{slug}"]?.get, "version"],
      [spec.paths["/api/news/{slug}"]?.get, "slug"],
      [spec.paths["/api/content/articles/{articleId}"]?.get, "articleId"],
      [spec.paths["/api/content/articles/{articleId}"]?.patch, "articleId"],
      [spec.paths["/api/content/articles/{articleId}:publish"]?.post, "articleId"],
      [spec.paths["/api/content/articles/{articleId}:unpublish"]?.post, "articleId"],
    ] as const) {
      expect(
        (operation?.parameters ?? []).some(
          (parameter) => "name" in parameter && parameter.name === name,
        ),
      ).toBe(true);
    }
  });

  it("keeps public 200/304 headers distinct from private 200/304 headers", () => {
    const [publicOk, publicNotModified] = publicConditionalResponses(Schema.String);
    const [privateOk, privateNotModified] = privateConditionalResponses(Schema.String);
    expect(publicOk.headers).toBe(PublicConditionalResponseHeaders);
    expect(publicNotModified.headers).toBe(PublicConditionalResponseHeaders);
    expect(privateOk.headers).toBe(ProfileReadResponseHeaders);
    expect(privateNotModified.headers).toBe(ProfileReadResponseHeaders);
    expect(PublicConditionalResponseHeaders).not.toBe(ProfileReadResponseHeaders);

    const headers = {
      "cache-control": "public, max-age=60, s-maxage=300, must-revalidate",
      vary: "Origin",
      etag: `"vkr2.${"A".repeat(43)}"`,
    };

    expect(Schema.decodeUnknownResult(PublicConditionalResponseHeaders)(headers)).toEqual(
      Result.succeed(headers),
    );
    expect(Result.isFailure(Schema.decodeUnknownResult(ProfileReadResponseHeaders)(headers))).toBe(
      true,
    );

    const publicProbe = HttpApiEndpoint.get("publicProbe", "/public-probe", {
      success: publicConditionalResponses(Schema.String),
    });

    const privateProbe = HttpApiEndpoint.get("privateProbe", "/private-probe", {
      success: privateConditionalResponses(Schema.String),
    });

    const headerSchemas = (endpoint: { readonly success: ReadonlySet<Schema.Top> }) =>
      [...endpoint.success].map((response) =>
        HttpApiSchema.isWithHeaders(response) ? response.headers.ast : undefined,
      );

    for (const [endpoint, expected] of [
      [listNews, publicProbe],
      [readNewsArticle, publicProbe],
      [readArticle, privateProbe],
    ] as const) {
      expect(endpoint.success.size).toBe(2);
      expect(headerSchemas(endpoint)).toEqual(headerSchemas(expected));
    }
  });

  it("preserves annotated public success identifiers, descriptions and examples", () => {
    const spec = OpenApi.fromApi(ExternalNativeApi);
    expect(spec.components.schemas.PublishedNewsListing).toMatchObject({
      description: "Current public news listing.",
      examples: [NewsListingExample],
    });
    expect(spec.components.schemas.PublishedNewsArticle).toMatchObject({
      description: "One published news article.",
      examples: [NewsArticleExample],
    });
    expect(PublishedNewsListingResponse).toBeDefined();
    expect(PublishedNewsArticleResponse).toBeDefined();
  });

  it("derives generated HTTP problem codes, statuses, and headers from each closed tuple", () => {
    const registry: ProblemRegistry = nativeProblems;
    const actualSpec = OpenApi.fromApi(ExternalNativeApi);

    const operations = new Map(
      Object.values(actualSpec.paths).flatMap((path) =>
        (["get", "post", "patch"] as const).flatMap((method) => {
          const operation = path[method];

          return operation === undefined ? [] : [[operation.operationId, operation] as const];
        }),
      ),
    );

    for (const [endpoint, codes, union, identifier] of problemCases) {
      expect(union.members.map((member) => member.fields.code.literal)).toEqual(codes);

      const expectedEndpoint = HttpApiEndpoint.get("problemProbe", "/problem-probe", {
        error: registry(identifier, codes),
      });

      const expectedSpec = OpenApi.fromApi(
        HttpApi.make("problem-probe").add(HttpApiGroup.make("problem-probe").add(expectedEndpoint)),
      );

      const actualOperation = operations.get("content." + endpoint.identifier);
      const expectedOperation = expectedSpec.paths["/problem-probe"]?.get;
      expect(actualOperation).toBeDefined();

      for (const status of new Set(codes.map((code) => NativeProblemRegistry[code].status))) {
        expect(actualOperation?.responses[status]).toEqual(expectedOperation?.responses[status]);
      }

      expect(actualSpec.components.schemas[identifier]).toEqual(
        expectedSpec.components.schemas[identifier],
      );
      expect(endpoint.error.size).toBe(
        new Set(codes.map((code) => NativeProblemRegistry[code].status)).size,
      );
    }

    expect(() => registry("UnknownContentProblem", ["not-a-native-problem"])).toThrow();
  });

  it("derives six Person and two Anonymous specs exactly as the live native endpoints", () => {
    for (const { endpoint, capability, resolver, requirements, time } of staffCases) {
      const annotations = contentAccessAnnotations(
        staffAccess(capability, resolver, requirements, time),
      );

      expect(Context.get(annotations, AccessSpecAnnotation)).toEqual(
        Option.getOrThrow(reflectAccessSpec(endpoint)),
      );
      expect(endpoint.middlewares.has(PersonSecurity)).toBe(true);
    }

    for (const { endpoint, resolver } of publicCases) {
      const annotations = contentAccessAnnotations(publicAccess(resolver));
      expect(Context.get(annotations, AccessSpecAnnotation)).toEqual(
        Option.getOrThrow(reflectAccessSpec(endpoint)),
      );
      expect(endpoint.middlewares.size).toBe(0);
    }
  });

  it("rejects every staff cross-product of wrong resolver, credential, principal, requirement or time", () => {
    const resolvers = [
      ContentArticlesResolver,
      ContentArticleCreateResolver,
      ContentArticleByIdResolver,
      ...publicCases.map(({ resolver }) => resolver),
    ];

    for (const { capability, resolver, requirements, time } of staffCases) {
      const valid = staffAccess(capability, resolver, requirements, time);

      for (const wrong of resolvers) {
        if (wrong !== resolver)
          expect(() =>
            contentAccessAnnotations({ ...valid, canonicalScopeResolver: wrong }),
          ).toThrow();
      }

      expect(() =>
        contentAccessAnnotations({ ...valid, canonicalScopeResolver: { id: resolver.id } }),
      ).toThrow();
      expect(() =>
        contentAccessAnnotations({
          ...valid,
          acceptedCredentials: ["OAuthUserBearer", "BetterAuthCookie"],
        }),
      ).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, acceptedCredentials: ["None"] })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, principalKinds: ["Anonymous"] })).toThrow();
      expect(() =>
        contentAccessAnnotations({
          ...valid,
          decisionTime: time === "Transaction" ? "SnapshotRead" : "Transaction",
        }),
      ).toThrow();
      expect(() =>
        contentAccessAnnotations({
          ...valid,
          requirements: [{ id: "content.revisable" }, { id: "content.publishable" }],
        }),
      ).toThrow();
      expect(() =>
        contentAccessAnnotations({
          ...valid,
          requirements: [{ id: "content.unpublishable", parameters: { department: "1" } }],
        }),
      ).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, capabilities: Capability.none })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, exposure: "Internal" })).toThrow();
      expect(() =>
        contentAccessAnnotations({ ...valid, concealment: Concealment.notFound("Requirement") }),
      ).toThrow();
    }

    const publish = staffAccess(
      "content.publish-article",
      ContentArticleByIdResolver,
      ["content.publishable"],
      "Transaction",
    );

    expect(() => contentAccessAnnotations({ ...publish, requirements: [] })).toThrow();
    expect(() =>
      contentAccessAnnotations({ ...publish, requirements: [{ id: "content.revisable" }] }),
    ).toThrow();

    const unpublish = staffAccess(
      "content.publish-article",
      ContentArticleByIdResolver,
      ["content.unpublishable"],
      "Transaction",
    );

    expect(() => contentAccessAnnotations({ ...unpublish, requirements: [] })).toThrow();
  });

  it("rejects public routes promoted to Person authority or paired with staff scopes and requirements", () => {
    for (const { resolver } of publicCases) {
      const valid = publicAccess(resolver);

      for (const staff of staffCases) {
        expect(() =>
          contentAccessAnnotations({ ...valid, canonicalScopeResolver: staff.resolver }),
        ).toThrow();
        expect(() =>
          contentAccessAnnotations({ ...valid, capabilities: Capability.one(staff.capability) }),
        ).toThrow();
      }

      expect(() =>
        contentAccessAnnotations({ ...valid, canonicalScopeResolver: { id: resolver.id } }),
      ).toThrow();
      expect(() =>
        contentAccessAnnotations({
          ...valid,
          acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
        }),
      ).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, principalKinds: ["Person"] })).toThrow();
      expect(() =>
        contentAccessAnnotations({ ...valid, requirements: [{ id: "content.publishable" }] }),
      ).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, decisionTime: "Transaction" })).toThrow();
      expect(() =>
        contentAccessAnnotations({ ...valid, concealment: Concealment.notFound("Authority") }),
      ).toThrow();
    }
  });
});
