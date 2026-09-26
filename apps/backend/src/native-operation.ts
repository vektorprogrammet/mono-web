import { CredentialMechanismSchema, PrincipalSchema } from "@vektorprogrammet/domain/authz";
import {
  AuthorityRef,
  AuthorizationInstant,
  AuthorityVersion,
  CredentialEvidenceRef,
  DomainId,
  GrantId,
  ResourceId,
  ResourceKind,
  type AccessSpec,
  type CanonicalScopeResolution,
  type CredentialOutcome,
  type Grant,
  type Scope,
  accessHttpStatus,
  evaluateAccessJourney,
  decodeGrant,
} from "@vektorprogrammet/domain/authz";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import { Data, Match, Predicate, Effect, type Schema } from "effect";

const capabilities = (spec: AccessSpec) => {
  return Match.value(spec.capabilities).pipe(
    Match.tag("None", () => {
      return [];
    }),
    Match.tag("One", (capabilities) => {
      return [capabilities.capability];
    }),
    Match.tag("All", "Any", (capabilities) => {
      return capabilities.capabilities;
    }),
    Match.exhaustive,
  );
};

/**
 * An AccessSpec evaluation that did not grant the operation. The status is
 * the concealment-aware answer: an unaccepted credential, a denial, or a
 * concealed resource.
 */
export class NativeAccessRejected extends Data.TaggedError("NativeAccessRejected")<{
  readonly status: 401 | 403 | 404;
}> {}

export const authorizeAnonymousNativeOperation = (
  spec: AccessSpec,
  resolution: CanonicalScopeResolution<Schema.JsonObject>,
  now: string,
): Effect.Effect<void, NativeAccessRejected> =>
  evaluateAccessJourney(spec, undefined, {
    now: Effect.succeed(AuthorizationInstant.make(now)),
    resolveCredential: () =>
      Effect.succeed({
        _tag: "Accepted" as const,
        mechanism: CredentialMechanismSchema.cases.None.make({}),
        principal: PrincipalSchema.cases.Anonymous.make({}),
        evidenceRef: CredentialEvidenceRef.make("anonymous"),
      }),
    resolveScope: () => Effect.succeed(resolution),
    resolveGrants: () => Effect.succeed([]),
  }).pipe(
    Effect.flatMap((evaluation) => {
      const status = accessHttpStatus(evaluation, spec.concealment);

      return status === 200 ? Effect.void : Effect.fail(new NativeAccessRejected({ status }));
    }),
  );

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

/** One person-credential AccessSpec evaluation for a native operation. */
export interface NativePersonAuthorization {
  readonly spec: AccessSpec;
  readonly credential?: AcceptedCredential;
  readonly request?: Request;
  readonly personId: PersonId;
  readonly resolution: CanonicalScopeResolution<Schema.JsonObject>;
  readonly grantScopes: ReadonlyArray<Scope>;
  readonly now: string;
}

export const authorizePersonNativeOperation = (
  input: NativePersonAuthorization,
): Effect.Effect<void, NativeAccessRejected> => {
  const credential =
    input.credential ??
    (input.request === undefined
      ? undefined
      : ({
          _tag: "Accepted" as const,
          mechanism: {
            _tag:
              input.request.headers.get("authorization")?.startsWith("Bearer ") === true
                ? ("OAuthUserBearer" as const)
                : ("BetterAuthCookie" as const),
          },
          principal: PrincipalSchema.cases.Person.make({ personId: input.personId }),
          evidenceRef: CredentialEvidenceRef.make("native-person-credential"),
        } satisfies AcceptedCredential));

  if (credential === undefined) {
    return Effect.fail(new NativeAccessRejected({ status: 401 }));
  }

  if (
    !Predicate.isTagged(credential.principal, "Person") ||
    credential.principal.personId !== input.personId
  ) {
    return Effect.fail(new NativeAccessRejected({ status: 401 }));
  }

  const instant = AuthorizationInstant.make(input.now);
  const principal = credential.principal;

  const grants: ReadonlyArray<Grant> = capabilities(input.spec).flatMap(
    (capability, capabilityIndex) =>
      input.grantScopes.map((scope, scopeIndex) =>
        decodeGrant({
          grantId: GrantId.make(
            `native-role:${input.personId}:${capability.type}:${capabilityIndex}:${scopeIndex}`,
          ),
          subject: principal,
          capability,
          scope,
          startAt: instant,
          endAt: null,
          requirements: [],
          source: AuthorityRef.make("native-role-projection"),
          revision: 0,
        }),
      ),
  );

  return evaluateAccessJourney(input.spec, undefined, {
    now: Effect.succeed(instant),
    resolveCredential: () => Effect.succeed(credential),
    resolveScope: () => Effect.succeed(input.resolution),
    resolveGrants: () => Effect.succeed(grants),
  }).pipe(
    Effect.flatMap((evaluation) => {
      const status = accessHttpStatus(evaluation, input.spec.concealment);

      return status === 200 ? Effect.void : Effect.fail(new NativeAccessRejected({ status }));
    }),
  );
};

export const genericContext = (input: {
  readonly domainId: Parameters<typeof DomainId.make>[0];
  readonly departmentId?: CanonicalScopeResolution["contexts"][number]["departmentId"];
  readonly resourceKind?: Parameters<typeof ResourceKind.make>[0];
  readonly resourceId?: Parameters<typeof ResourceId.make>[0];
  readonly authorityVersion: string;
  readonly facts?: Readonly<Schema.JsonObject>;
}) => ({
  domainId: DomainId.make(input.domainId),
  departmentId: input.departmentId ?? null,
  resource:
    input.resourceKind === undefined || input.resourceId === undefined
      ? null
      : { kind: ResourceKind.make(input.resourceKind), id: ResourceId.make(input.resourceId) },
  facts: input.facts ?? {},
  authorityVersion: AuthorityVersion.make(input.authorityVersion),
});
