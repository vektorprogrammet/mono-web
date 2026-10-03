import { Capability, Concealment, type HttpAccessAnnotationSpec, type ProblemRegistry } from "@effx/runtime";
import { Context, Option, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
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
  CreateArticleEndpoint,
  ListNewsEndpoint,
  NewsArticleExample,
  NewsListingExample,
  NewsVersionQuery,
  PublishedNewsArticleResponse,
  PublishedNewsListingResponse,
  PublishArticleEndpoint,
  ReadArticleEndpoint,
  ReadContentWorkspaceEndpoint,
  ReadNewsArticleEndpoint,
  ReviseArticleEndpoint,
  UnpublishArticleEndpoint,
} from "../src/content.js";
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
  { endpoint: ReadContentWorkspaceEndpoint, capability: "content.read-workspace", resolver: ContentArticlesResolver, requirements: [], time: "SnapshotRead" },
  { endpoint: CreateArticleEndpoint, capability: "content.create-article", resolver: ContentArticleCreateResolver, requirements: [], time: "Transaction" },
  { endpoint: ReadArticleEndpoint, capability: "content.read-article", resolver: ContentArticleByIdResolver, requirements: [], time: "SnapshotRead" },
  { endpoint: ReviseArticleEndpoint, capability: "content.revise-article", resolver: ContentArticleByIdResolver, requirements: ["content.revisable"], time: "Transaction" },
  { endpoint: PublishArticleEndpoint, capability: "content.publish-article", resolver: ContentArticleByIdResolver, requirements: ["content.publishable"], time: "Transaction" },
  { endpoint: UnpublishArticleEndpoint, capability: "content.publish-article", resolver: ContentArticleByIdResolver, requirements: ["content.unpublishable"], time: "Transaction" },
] as const;

const publicCases = [
  { endpoint: ListNewsEndpoint, resolver: ContentPublicNewsResolver },
  { endpoint: ReadNewsArticleEndpoint, resolver: ContentPublicNewsBySlugResolver },
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
  [ContentReadContentWorkspaceCodes, ContentReadContentWorkspaceProblem, "ContentReadContentWorkspaceProblem"],
  [ContentCreateArticleCodes, ContentCreateArticleProblem, "ContentCreateArticleProblem"],
  [ContentReadArticleCodes, ContentReadArticleProblem, "ContentReadArticleProblem"],
  [ContentReviseArticleCodes, ContentReviseArticleProblem, "ContentReviseArticleProblem"],
  [ContentPublishArticleCodes, ContentPublishArticleProblem, "ContentPublishArticleProblem"],
  [ContentUnpublishArticleCodes, ContentUnpublishArticleProblem, "ContentUnpublishArticleProblem"],
  [ContentListNewsCodes, ContentListNewsProblem, "ContentListNewsProblem"],
  [ContentReadNewsArticleCodes, ContentReadNewsArticleProblem, "ContentReadNewsArticleProblem"],
] as const;

describe("Content effx source preparation", () => {
  it("reuses actual Struct query and route parameter schemas on the handwritten endpoints", () => {
    expect(Schema.decodeSync(ContentDepartmentQuery)({})).toEqual({});
    expect(Schema.decodeSync(ContentDepartmentQuery)({ department: "1" })).toEqual({ department: "1" });
    expect(Schema.decodeSync(NewsVersionQuery)({ version: 1 })).toEqual({ version: 1 });
    expect(() => Schema.decodeSync(NewsVersionQuery)({ version: 0 })).toThrow();
    expect(Schema.decodeSync(ContentArticleParams)({ articleId: 1 })).toEqual({ articleId: 1 });
    expect(Schema.decodeSync(ContentNewsSlugParams)({ slug: "penerimaan-anggota-2026" })).toEqual({ slug: "penerimaan-anggota-2026" });

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
      expect((operation?.parameters ?? []).some((parameter) => "name" in parameter && parameter.name === name)).toBe(true);
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
    const headers = { "cache-control": "public, max-age=60, s-maxage=300, must-revalidate", vary: "Origin", etag: `"vkr2.${"A".repeat(43)}"` };
    expect(Schema.decodeUnknownSync(PublicConditionalResponseHeaders)(headers)).toEqual(headers);
    expect(() => Schema.decodeUnknownSync(ProfileReadResponseHeaders)(headers)).toThrow();
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

  it("derives every exact ordered closed problem union from its one exported tuple", () => {
    const registry: ProblemRegistry = nativeProblems;

    for (const [codes, union, identifier] of problemCases) {
      expect(union.members.map((member) => member.fields.code.literal)).toEqual(codes);
      expect(registry(identifier, codes)).toHaveLength(
        new Set(codes.map((code) => NativeProblemRegistry[code].status)).size,
      );
    }

    expect(() => registry("UnknownContentProblem", ["not-a-native-problem"])).toThrow();
  });

  it("derives six Person and two Anonymous specs exactly as the live native endpoints", () => {
    for (const { endpoint, capability, resolver, requirements, time } of staffCases) {
      const annotations = contentAccessAnnotations(staffAccess(capability, resolver, requirements, time));
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
    const resolvers = [ContentArticlesResolver, ContentArticleCreateResolver, ContentArticleByIdResolver, ...publicCases.map(({ resolver }) => resolver)];

    for (const { capability, resolver, requirements, time } of staffCases) {
      const valid = staffAccess(capability, resolver, requirements, time);

      for (const wrong of resolvers) {
        if (wrong !== resolver) expect(() => contentAccessAnnotations({ ...valid, canonicalScopeResolver: wrong })).toThrow();
      }

      expect(() => contentAccessAnnotations({ ...valid, canonicalScopeResolver: { id: resolver.id } })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, acceptedCredentials: ["OAuthUserBearer", "BetterAuthCookie"] })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, acceptedCredentials: ["None"] })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, principalKinds: ["Anonymous"] })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, decisionTime: time === "Transaction" ? "SnapshotRead" : "Transaction" })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, requirements: [{ id: "content.revisable" }, { id: "content.publishable" }] })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, requirements: [{ id: "content.unpublishable", parameters: { department: "1" } }] })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, capabilities: Capability.none })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, exposure: "Internal" })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, concealment: Concealment.notFound("Requirement") })).toThrow();
    }

    const publish = staffAccess("content.publish-article", ContentArticleByIdResolver, ["content.publishable"], "Transaction");
    expect(() => contentAccessAnnotations({ ...publish, requirements: [] })).toThrow();
    expect(() => contentAccessAnnotations({ ...publish, requirements: [{ id: "content.revisable" }] })).toThrow();
    const unpublish = staffAccess("content.publish-article", ContentArticleByIdResolver, ["content.unpublishable"], "Transaction");
    expect(() => contentAccessAnnotations({ ...unpublish, requirements: [] })).toThrow();
  });

  it("rejects public routes promoted to Person authority or paired with staff scopes and requirements", () => {
    for (const { resolver } of publicCases) {
      const valid = publicAccess(resolver);

      for (const staff of staffCases) {
        expect(() => contentAccessAnnotations({ ...valid, canonicalScopeResolver: staff.resolver })).toThrow();
        expect(() => contentAccessAnnotations({ ...valid, capabilities: Capability.one(staff.capability) })).toThrow();
      }

      expect(() => contentAccessAnnotations({ ...valid, canonicalScopeResolver: { id: resolver.id } })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"] })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, principalKinds: ["Person"] })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, requirements: [{ id: "content.publishable" }] })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, decisionTime: "Transaction" })).toThrow();
      expect(() => contentAccessAnnotations({ ...valid, concealment: Concealment.notFound("Authority") })).toThrow();
    }
  });
});
