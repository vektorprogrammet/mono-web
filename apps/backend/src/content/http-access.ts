/** Content access: the content grant scope, article access contexts, and the person access check. */
import {
  AuthorityVersion,
  DomainId,
  ResourceId,
  ResourceKind,
  Scope,
  type CanonicalScopeResolution,
  type CredentialOutcome,
} from "@vektorprogrammet/domain/authz";
import type { ContentArticleDetail } from "@vektorprogrammet/domain/content";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import { reflectAccessSpec } from "@vektorprogrammet/http-api";
import type { CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { type Effect, Option, type Schema } from "effect";
import { authorizePerson, unreachable } from "../http-api/problem.js";
import type { ContentEndpoint } from "./http-context.js";

export const contentScope: Scope = Scope.Domain({ domainId: DomainId.make("content") });

/**
 * Evaluates a content endpoint's AccessSpec for one person with the content grant scope.
 *
 * @remarks
 * It runs `authorizePerson` with the endpoint's AccessSpec, the content domain as the grant scope,
 * and `resolution` at `authorizationInstant`. A command passes the credential that its
 * transaction resolved; a read passes the request, from which the credential is derived. Content
 * access reveals every denial, so `unreachable("resource.not-found")` removes the concealment
 * answer.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* authorizeContentOperation({ endpoint: ReviseArticleEndpoint, credential: actor.credential, personId: actor.personId, authorizationInstant, resolution, presentation });
 * ```
 *
 * @avoid Granting a content operation from a role check in the handler: the AccessSpec of the
 * contract then stops being the authority for the endpoint. Evaluate it with this.
 *
 * @construct http-problem
 */
export const authorizeContentOperation = (input: {
  readonly endpoint: ContentEndpoint;
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
      spec: Option.getOrThrow(reflectAccessSpec(input.endpoint)),
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

export const articleContext = (
  detail: ContentArticleDetail,
  createdByPersonId: PersonId,
  authorityVersion: string,
) => ({
  domainId: DomainId.make("content"),
  departmentId: detail.departmentIds[0] ?? null,
  resource: {
    kind: ResourceKind.make("content-article"),
    id: ResourceId.make(String(detail.articleId)),
  },
  facts: {
    state: detail.status,
    ownerPersonId: createdByPersonId,
    revisable: detail.canRevise,
    publishable: detail.canPublish,
    unpublishable: detail.status === "Published",
  },
  authorityVersion: AuthorityVersion.make(authorityVersion),
});
