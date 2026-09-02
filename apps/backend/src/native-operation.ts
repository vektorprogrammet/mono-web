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
  makeGrant,
} from "@vektorprogrammet/domain/authz";
import type {
  NativeHttpCommandOutcome,
  NativeHttpCommandPlan,
} from "@vektorprogrammet/domain/http-semantics";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import { Effect } from "effect";
import {
  HttpSemanticFailure,
  nativeProblemResponse,
  responseFromCapsule,
} from "./http-semantics.js";
import type { BackendRun } from "./router.js";

const capabilities = (spec: AccessSpec) => {
  switch (spec.capabilities._tag) {
    case "None":
      return [];
    case "One":
      return [spec.capabilities.capability];
    case "All":
    case "Any":
      return spec.capabilities.capabilities;
  }
};

const rejectedCode = (status: 401 | 403 | 404) =>
  status === 401
    ? "credential.invalid"
    : status === 404
      ? "resource.not-found"
      : "authority.denied";
type RunRequirement<Run> =
  Run extends <A, E>(effect: Effect.Effect<A, E, infer R>) => Promise<A> ? R : never;

/**
 * Adapts an existing Promise-oriented backend boundary to the current Effect
 * runtime. The first argument is a type witness only. At execution, the nested
 * runner inherits the SQL transaction connection and the witness's services.
 */
export const prepareNativeHttpCommand = <Run, E, R>(
  _run: Run,
  prepare: (run: Run) => Promise<NativeHttpCommandPlan<E, R>>,
): Effect.Effect<NativeHttpCommandPlan<E, R>, E, RunRequirement<Run>> =>
  Effect.flatMap(Effect.context<RunRequirement<Run>>(), (context) =>
    Effect.tryPromise({
      try: () => prepare(Effect.runPromiseWith(context) as unknown as Run),
      catch: (cause) => cause as E,
    }),
  );


export const authorizeAnonymousNativeOperation = async (
  spec: AccessSpec,
  resolution: CanonicalScopeResolution<Record<string, unknown>>,
  now: string,
  run: BackendRun,
): Promise<void> => {
  const evaluation = await run(
    evaluateAccessJourney(spec, undefined, {
      now: Effect.succeed(AuthorizationInstant.make(now)),
      resolveCredential: () =>
        Effect.succeed({
          _tag: "Accepted" as const,
          mechanism: { _tag: "None" as const },
          principal: { _tag: "Anonymous" as const },
          evidenceRef: CredentialEvidenceRef.make("anonymous"),
        }),
      resolveScope: () => Effect.succeed(resolution),
      resolveGrants: () => Effect.succeed([]),
    }),
  );
  const status = accessHttpStatus(evaluation, spec.concealment);
  if (status !== 200) throw new HttpSemanticFailure(rejectedCode(status), status);
};

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

export const authorizePersonNativeOperation = async (input: {
  readonly spec: AccessSpec;
  readonly credential?: AcceptedCredential;
  readonly request?: Request;
  readonly personId: PersonId;
  readonly resolution: CanonicalScopeResolution<Record<string, unknown>>;
  readonly grantScopes: ReadonlyArray<Scope>;
  readonly now: string;
  readonly run: BackendRun;
}): Promise<void> => {
  const credential =
    input.credential ??
    (input.request === undefined
      ? undefined
      : ({
          _tag: "Accepted" as const,
          mechanism: {
            _tag: input.request.headers.get("authorization")?.startsWith("Bearer ") === true
              ? ("OAuthUserBearer" as const)
              : ("BetterAuthCookie" as const),
          },
          principal: { _tag: "Person" as const, personId: input.personId },
          evidenceRef: CredentialEvidenceRef.make("native-person-credential"),
        } satisfies AcceptedCredential));
  if (credential === undefined) throw new HttpSemanticFailure("credential.invalid", 401);
  if (
    credential.principal._tag !== "Person" ||
    credential.principal.personId !== input.personId
  ) {
    throw new HttpSemanticFailure("credential.invalid", 401);
  }
  const instant = AuthorizationInstant.make(input.now);
  const principal = credential.principal;
  const grants: ReadonlyArray<Grant> = capabilities(input.spec).flatMap(
    (capability, capabilityIndex) =>
      input.grantScopes.map((scope, scopeIndex) =>
        makeGrant({
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
  const evaluation = await input.run(
    evaluateAccessJourney(input.spec, undefined, {
      now: Effect.succeed(instant),
      resolveCredential: () => Effect.succeed(credential),
      resolveScope: () => Effect.succeed(input.resolution),
      resolveGrants: () => Effect.succeed(grants),
    }),
  );
  const status = accessHttpStatus(evaluation, input.spec.concealment);
  if (status !== 200) throw new HttpSemanticFailure(rejectedCode(status), status);
};

export const genericContext = (input: {
  readonly domainId: Parameters<typeof DomainId.make>[0];
  readonly departmentId?: CanonicalScopeResolution["contexts"][number]["departmentId"];
  readonly resourceKind?: Parameters<typeof ResourceKind.make>[0];
  readonly resourceId?: Parameters<typeof ResourceId.make>[0];
  readonly authorityVersion: string;
  readonly facts?: Readonly<Record<string, unknown>>;
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

export const nativeCommandOutcomeResponse = (outcome: NativeHttpCommandOutcome): Response => {
  switch (outcome._tag) {
    case "Committed":
    case "Replay":
      return responseFromCapsule(outcome.response);
    case "InFlight":
      return nativeProblemResponse("idempotency.in-flight", 409, { "retry-after": "1" });
    case "DigestConflict":
      return nativeProblemResponse("idempotency.digest-conflict", 409);
    case "ResponseExpired":
      return nativeProblemResponse("idempotency.response-expired", 409);
  }
};
