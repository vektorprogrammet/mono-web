/** Content access: grant scope, article access contexts, and person or anonymous access checks. */
import {
  AuthorityRef,
  AuthorityVersion,
  AuthorizationInstant,
  CredentialEvidenceRef,
  DomainId,
  GrantId,
  ResourceId,
  ResourceKind,
  Scope,
  accessHttpStatus,
  decodeGrant,
  evaluateAccessJourney,
  type AccessSpec,
  type CanonicalScopeResolution,
} from "@vektorprogrammet/domain/authz";
import type { ContentArticleDetail } from "@vektorprogrammet/domain/content";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import { DateTime, Effect, Match, Predicate } from "effect";
import { HttpSemanticFailure } from "../http-semantics.js";
import type { AuthorizedContentActor } from "./http-context.js";

interface ContentAccessFacts {
  readonly state?: string;
  readonly ownerPersonId?: PersonId;
  readonly publishable?: boolean;
  readonly unpublishable?: boolean;
}

export const contentScope: Scope = Scope.Domain({ domainId: DomainId.make("content") });

export const authorizeContentOperation = (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
  readonly actor: AuthorizedContentActor;
  readonly resolution: CanonicalScopeResolution<ContentAccessFacts>;
}) => {
  const instant = AuthorizationInstant.make(input.actor.authorizationInstant);
  const principal = { _tag: "Person" as const, personId: input.actor.personId };

  const capabilityList = Predicate.isTagged(input.spec.capabilities, "One")
    ? [input.spec.capabilities.capability]
    : Predicate.isTagged(input.spec.capabilities, "All") ||
        Predicate.isTagged(input.spec.capabilities, "Any")
      ? input.spec.capabilities.capabilities
      : [];

  const grants = capabilityList.map((capability, index) =>
    decodeGrant({
      grantId: GrantId.make(`native-content:${input.actor.personId}:${index}`),
      subject: principal,
      capability,
      scope: contentScope,
      startAt: instant,
      endAt: null,
      requirements: [],
      source: AuthorityRef.make("native-content-role-projection"),
      revision: 0,
    }),
  );

  const bearer = input.request.headers.get("authorization")?.startsWith("Bearer ") === true;

  return evaluateAccessJourney(input.spec, undefined, {
    now: Effect.succeed(instant),
    resolveCredential: () =>
      Effect.succeed({
        _tag: "Accepted" as const,
        mechanism: {
          _tag: bearer ? ("OAuthUserBearer" as const) : ("BetterAuthCookie" as const),
        },
        principal,
        evidenceRef: CredentialEvidenceRef.make("native-content-person-credential"),
      }),
    resolveScope: () => Effect.succeed(input.resolution),
    resolveGrants: () => Effect.succeed(grants),
  }).pipe(
    Effect.flatMap((evaluation) => {
      const status = accessHttpStatus(evaluation, input.spec.concealment);

      return status === 200
        ? Effect.void
        : Effect.fail(
            new HttpSemanticFailure(
              Match.value(status).pipe(
                Match.when(401, () => "credential.invalid" as const),
                Match.when(404, () => "resource.not-found" as const),
                Match.orElse(() => "authority.denied" as const),
              ),
              status,
            ),
          );
    }),
  );
};

export const authorizeAnonymousContentOperation = (
  spec: AccessSpec,
  resolution: CanonicalScopeResolution<Record<string, never>>,
) =>
  Effect.gen(function* () {
    const instant = AuthorizationInstant.make(DateTime.formatIso(yield* DateTime.now));

    const evaluation = yield* evaluateAccessJourney(spec, undefined, {
      now: Effect.succeed(instant),
      resolveCredential: () =>
        Effect.succeed({
          _tag: "Accepted" as const,
          mechanism: { _tag: "None" as const },
          principal: { _tag: "Anonymous" as const },
          evidenceRef: CredentialEvidenceRef.make("native-content-anonymous"),
        }),
      resolveScope: () => Effect.succeed(resolution),
      resolveGrants: () => Effect.succeed([]),
    });

    const status = accessHttpStatus(evaluation, spec.concealment);

    if (status !== 200) {
      return yield* Effect.fail(
        new HttpSemanticFailure(status === 404 ? "resource.not-found" : "authority.denied", status),
      );
    }
  });

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
