/**
 * Content access: the content grant scope, article access contexts, the person access check, and
 * the article entity tag.
 */
import {
  readContentArticleHttpSourcePostgres,
  readContentAuthorityHttpSourcesPostgres,
} from "@vektorprogrammet/database/content";
import {
  AuthorityVersion,
  DomainId,
  ResourceId,
  ResourceKind,
  Scope,
  type CanonicalScopeResolution,
  type CredentialOutcome,
} from "@vektorprogrammet/domain/authz";
import type { ArticleId, ContentArticleDetail } from "@vektorprogrammet/domain/content";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import { reflectAccessSpec } from "@vektorprogrammet/rpc";
import type { CredentialPresentation, Problem, StrongETag } from "@vektorprogrammet/rpc/problem";
import { Effect, Option, type Schema } from "effect";
import type { Rpc } from "effect/unstable/rpc";
import { deriveStrongETag } from "../http-semantics.js";
import { authorizePerson, unreachable } from "../rpc/problem.js";

export const contentScope: Scope = Scope.Domain({ domainId: DomainId.make("content") });

/**
 * Evaluates a content RPC's AccessSpec for one person with the content grant scope.
 *
 * @remarks
 * It runs `authorizePerson` with the RPC's AccessSpec, the content domain as the grant scope, and
 * `resolution` at `authorizationInstant`. A command passes the credential that its transaction
 * resolved; a read passes the credential request, from which the credential is derived. Content
 * access reveals every denial, so `unreachable("resource.not-found")` removes the concealment
 * answer.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* authorizeContentOperation({ rpc: ReviseArticle, credential: actor.credential, personId: actor.personId, authorizationInstant, resolution, presentation });
 * ```
 *
 * @avoid Granting a content operation from a role check in the handler: the AccessSpec of the
 * contract then stops being the authority for the RPC. Evaluate it with this.
 *
 * @construct rpc-problem
 */
export const authorizeContentOperation = (input: {
  readonly rpc: Pick<Rpc.AnyWithProps, "annotations">;
  readonly personId: PersonId;
  readonly authorizationInstant: string;
  readonly credential?: Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;
  readonly request?: Request;
  readonly resolution: CanonicalScopeResolution<Schema.JsonObject>;
  readonly presentation: CredentialPresentation;
}): Effect.Effect<
  void,
  Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">
> =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
      credential: input.credential,
      request: input.request,
      personId: input.personId,
      resolution: input.resolution,
      grantScopes: [contentScope],
      now: input.authorizationInstant,
    },
    input.presentation,
  ).pipe(
    // Content access reveals every denial, so it never conceals a resource as not found.
    unreachable("resource.not-found"),
  );

/** The access context of one article: its first department, its state, and its owner. */
export const articleContext = (input: {
  readonly detail: ContentArticleDetail;
  readonly createdByPersonId: PersonId;
  readonly authorityVersion: string;
}) => ({
  domainId: DomainId.make("content"),
  departmentId: input.detail.departmentIds[0] ?? null,
  resource: {
    kind: ResourceKind.make("content-article"),
    id: ResourceId.make(String(input.detail.articleId)),
  },
  facts: {
    state: input.detail.status,
    ownerPersonId: input.createdByPersonId,
    revisable: input.detail.canRevise,
    publishable: input.detail.canPublish,
    unpublishable: input.detail.status === "Published",
  },
  authorityVersion: AuthorityVersion.make(input.authorityVersion),
});

/** The access context of a request that names no article, optionally within one department. */
export const unscopedContext = (input: {
  readonly departmentId: CanonicalScopeResolution["contexts"][number]["departmentId"];
  readonly authorityVersion: string;
}) => ({
  domainId: DomainId.make("content"),
  departmentId: input.departmentId,
  resource: null,
  facts: {},
  authorityVersion: AuthorityVersion.make(input.authorityVersion),
});

type ArticleSource = Effect.Success<ReturnType<typeof readContentArticleHttpSourcePostgres>>;

type AuthoritySources = Effect.Success<ReturnType<typeof readContentAuthorityHttpSourcesPostgres>>;

/**
 * The strong entity tag of one article detail, as the HTTP contract derived it: the article
 * revision, its author's profile revision, and the reader's content authority sources.
 */
export const articleETag = (input: {
  readonly articleId: ArticleId;
  readonly source: ArticleSource;
  readonly authority: AuthoritySources;
}): StrongETag =>
  deriveStrongETag({
    representationKind: "ContentArticleDetailSchema",
    resourceIdentity: `content-article:${input.articleId}`,
    version: [
      input.source.articleRevision,
      input.source.authorProfileRevision,
      input.authority.map((item) => [item.kind, item.identity, item.revisions]),
    ],
  });

/** Reads the sources of one article's entity tag for one reader, and derives the tag. */
export const readArticleETag = (input: {
  readonly articleId: ArticleId;
  readonly personId: PersonId;
}) =>
  Effect.all([
    readContentArticleHttpSourcePostgres(input.articleId),
    readContentAuthorityHttpSourcesPostgres(input.personId),
  ]).pipe(
    Effect.map(([source, authority]) =>
      articleETag({ articleId: input.articleId, source, authority }),
    ),
  );
