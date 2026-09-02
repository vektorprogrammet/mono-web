import {
  AuthorityRef,
  AuthorityVersion,
  DomainId,
  AuthorizationInstant,
  CredentialEvidenceRef,
  GrantId,
  ResourceId,
  ResourceKind,
  accessHttpStatus,
  evaluateAccessJourney,
  makeGrant,
  type AccessSpec,
  type CanonicalScopeResolution,
  type Grant,
  type Scope,
} from "@vektorprogrammet/domain/authz";
import type { NativeHttpCommandOutcome } from "@vektorprogrammet/domain/http-semantics";
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
  status === 401 ? "credential.invalid" : status === 404 ? "resource.not-found" : "authority.denied";

export const authorizeAnonymousNativeOperation = async (
  spec: AccessSpec,
  resolution: CanonicalScopeResolution<Record<string, never>>,
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

export const authorizePersonNativeOperation = async (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
  readonly personId: PersonId;
  readonly resolution: CanonicalScopeResolution<Record<string, never>>;
  readonly grantScopes: ReadonlyArray<Scope>;
  readonly now: string;
  readonly run: BackendRun;
}): Promise<void> => {
  const instant = AuthorizationInstant.make(input.now);
  const principal = { _tag: "Person" as const, personId: input.personId };
  const grants: ReadonlyArray<Grant> = capabilities(input.spec).flatMap((capability, capabilityIndex) =>
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
  const bearer = input.request.headers.get("authorization")?.startsWith("Bearer ") === true;
  const evaluation = await input.run(
    evaluateAccessJourney(input.spec, undefined, {
      now: Effect.succeed(instant),
      resolveCredential: () =>
        Effect.succeed({
          _tag: "Accepted" as const,
          mechanism: { _tag: bearer ? ("OAuthUserBearer" as const) : ("BetterAuthCookie" as const) },
          principal,
          evidenceRef: CredentialEvidenceRef.make("native-person-credential"),
        }),
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
}) => ({
  domainId: DomainId.make(input.domainId),
  departmentId: input.departmentId ?? null,
  resource:
    input.resourceKind === undefined || input.resourceId === undefined
      ? null
      : { kind: ResourceKind.make(input.resourceKind), id: ResourceId.make(input.resourceId) },
  facts: {},
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