import type { HttpAccessAnnotationSpec } from "@effx/runtime";
import { type SCOPE_RESOLVER_IDS } from "@vektorprogrammet/domain/authz";
import { Predicate, Schema } from "effect";
import { accessSpecAnnotations, anonymousNativeAccess, personNativeAccess } from "./access.js";
import { decodeDeclaredOrThrow } from "./declaration-decoding.js";

/** Exported resolver identities for the six staff and two public declarations. */
export const ContentArticlesResolver = { id: "content.articles" } as const satisfies {
  readonly id: (typeof SCOPE_RESOLVER_IDS)[number];
};

export const ContentArticleCreateResolver = { id: "content.article-create" } as const satisfies {
  readonly id: (typeof SCOPE_RESOLVER_IDS)[number];
};

export const ContentArticleByIdResolver = { id: "content.article-by-id" } as const satisfies {
  readonly id: (typeof SCOPE_RESOLVER_IDS)[number];
};

export const ContentPublicNewsResolver = { id: "content.public-news" } as const satisfies {
  readonly id: (typeof SCOPE_RESOLVER_IDS)[number];
};

export const ContentPublicNewsBySlugResolver = {
  id: "content.public-news-by-slug",
} as const satisfies {
  readonly id: (typeof SCOPE_RESOLVER_IDS)[number];
};

// These are the only six staff capability/resolver/requirement/time combinations.
// Publish and unpublish deliberately share one capability but require different lifecycle checks.
const staffPolicies = [
  {
    capability: "content.read-workspace",
    resolver: ContentArticlesResolver,
    requirements: [],
    decisionTime: "SnapshotRead",
  },
  {
    capability: "content.create-article",
    resolver: ContentArticleCreateResolver,
    requirements: [],
    decisionTime: "Transaction",
  },
  {
    capability: "content.read-article",
    resolver: ContentArticleByIdResolver,
    requirements: [],
    decisionTime: "SnapshotRead",
  },
  {
    capability: "content.revise-article",
    resolver: ContentArticleByIdResolver,
    requirements: ["content.revisable"],
    decisionTime: "Transaction",
  },
  {
    capability: "content.publish-article",
    resolver: ContentArticleByIdResolver,
    requirements: ["content.publishable"],
    decisionTime: "Transaction",
  },
  {
    capability: "content.publish-article",
    resolver: ContentArticleByIdResolver,
    requirements: ["content.unpublishable"],
    decisionTime: "Transaction",
  },
] as const;

const publicResolvers = [ContentPublicNewsResolver, ContentPublicNewsBySlugResolver] as const;

// A resolver is an exported symbol, not an object with a matching id supplied by a caller.
const resolverSymbol = <R extends { readonly id: (typeof SCOPE_RESOLVER_IDS)[number] }>(
  symbol: R,
) => Schema.declare((value: unknown): value is R => value === symbol);

const ContentResolver = Schema.Union([
  resolverSymbol(ContentArticlesResolver),
  resolverSymbol(ContentArticleCreateResolver),
  resolverSymbol(ContentArticleByIdResolver),
  resolverSymbol(ContentPublicNewsResolver),
  resolverSymbol(ContentPublicNewsBySlugResolver),
]);

const ContentAccess = Schema.Struct({
  exposure: Schema.Literal("External"),
  acceptedCredentials: Schema.Union([
    Schema.Tuple([Schema.Literal("BetterAuthCookie"), Schema.Literal("OAuthUserBearer")]),
    Schema.Tuple([Schema.Literal("None")]),
  ]),
  principalKinds: Schema.Union([
    Schema.Tuple([Schema.Literal("Person")]),
    Schema.Tuple([Schema.Literal("Anonymous")]),
  ]),
  capabilities: Schema.Union([
    Schema.TaggedStruct("One", {
      capability: Schema.Literals(staffPolicies.map(({ capability }) => capability)),
    }),
    Schema.TaggedStruct("None", {}),
  ]),
  requirements: Schema.Array(
    Schema.Struct({
      id: Schema.Literals(["content.revisable", "content.publishable", "content.unpublishable"]),
      parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.Never)),
    }),
  ),
  canonicalScopeResolver: ContentResolver,
  concealment: Schema.TaggedStruct("Reveal", {}),
  decisionTime: Schema.Literals(["SnapshotRead", "Transaction"]),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (spec) => {
        if (Predicate.isTagged(spec.capabilities, "One")) {
          const capability = spec.capabilities.capability;

          return (
            spec.acceptedCredentials.length === 2 &&
            spec.principalKinds[0] === "Person" &&
            staffPolicies.some(
              (policy) =>
                policy.capability === capability &&
                policy.resolver === spec.canonicalScopeResolver &&
                policy.decisionTime === spec.decisionTime &&
                policy.requirements.length === spec.requirements.length &&
                policy.requirements.every((id, index) => id === spec.requirements[index]?.id),
            )
          );
        }

        return (
          spec.acceptedCredentials.length === 1 &&
          spec.acceptedCredentials[0] === "None" &&
          spec.principalKinds[0] === "Anonymous" &&
          spec.requirements.length === 0 &&
          spec.decisionTime === "SnapshotRead" &&
          publicResolvers.some((resolver) => resolver === spec.canonicalScopeResolver)
        );
      },
      { message: "an exact staff or anonymous public Content access contract" },
    ),
  ),
);

const decodeContentAccess = decodeDeclaredOrThrow(ContentAccess, { onExcessProperty: "error" });

/** Derives only the six Person and two genuinely anonymous public native AccessSpecs. */
export const contentAccessAnnotations = (input: HttpAccessAnnotationSpec) => {
  const spec = decodeContentAccess(input);

  return accessSpecAnnotations(
    Predicate.isTagged(spec.capabilities, "One")
      ? personNativeAccess({
          capability: spec.capabilities.capability,
          canonicalScopeResolver: spec.canonicalScopeResolver.id,
          requirements: spec.requirements.map(({ id }) => id),
          decisionTime: spec.decisionTime,
        })
      : anonymousNativeAccess(spec.canonicalScopeResolver.id),
  );
};
