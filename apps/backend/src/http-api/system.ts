import { Scope } from "@vektorprogrammet/domain/authz";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { IdentitySnapshot, type IdentitySnapshotService } from "@vektorprogrammet/database";
import { databaseHealth, type Database } from "@vektorprogrammet/database";
import {
  Identity,
  IdentityEngineError,
  IdentityOwnedSessionNotFound,
  IdentitySessionExpired,
  IdentitySessionNotFound,
  type IdentityActor,
  type IdentitySession,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { executeNativeHttpCommandPostgres } from "./receipt-transaction.js";
import {
  DeleteOwnedSessionEndpoint,
  DeleteSessionEndpoint,
  ExternalNativeApi,
  HealthEndpoint,
  ListSessionsEndpoint,
  ReadSessionEndpoint,
  RevokeAllSessionsEndpoint,
  RevokeOtherSessionsEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import { Schema, Match, Predicate, DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  resolveAuthenticatedPersonAtInstant,
  resolveRequestCredentialInTransaction,
  type AuthenticatedPersonAtInstant,
} from "../authority.js";
import {
  HttpSemanticFailure,
  deriveHttpIdentity,
  encodePathIdentity,
  nativeProblemResponse,
  parseIdempotencyKey,
  semanticRequestDigest,
} from "../http-semantics.js";
import {
  authorizeAnonymousNativeOperation,
  authorizePersonNativeOperation,
  genericContext,
  nativeCommandOutcomeResponse,
} from "../native-operation.js";
import { identityRequestContext } from "../session-security.js";
import { isSerializationConflict } from "./problem.js";
import { toHttpApiResponse } from "./transport.js";

const jsonResponse = (
  body: Schema.Json,
  cacheControl: "no-store" | "private, no-store",
): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
    },
  });

const identityErrorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpSemanticFailure) {
    return nativeProblemResponse(cause.code, cause.status);
  }

  if (cause instanceof IdentityOwnedSessionNotFound) {
    return nativeProblemResponse("resource.not-found", 404);
  }

  if (
    cause instanceof UnauthenticatedActor ||
    cause instanceof IdentitySessionNotFound ||
    cause instanceof IdentitySessionExpired
  ) {
    return nativeProblemResponse("credential.invalid", 401, {
      "www-authenticate": 'VektorSession realm="native-api"',
    });
  }

  if (cause !== null && (cause === null || Predicate.isObjectOrArray(cause)) && "_tag" in cause) {
    const response = Match.value(cause).pipe(
      Match.when(Predicate.isTagged("NativeHttpReceiptInFlightError"), () => {
        return nativeProblemResponse("idempotency.in-flight", 409, { "retry-after": "1" });
      }),
      Match.when(Predicate.isTagged("NativeHttpReceiptDigestConflictError"), () => {
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      }),
      Match.when(Predicate.isTagged("NativeHttpReceiptExpiredError"), () => {
        return nativeProblemResponse("idempotency.response-expired", 409);
      }),
      Match.when(Predicate.isTagged("NativeHttpReceiptPersistenceError"), () => {
        return nativeProblemResponse("idempotency.unavailable", 503);
      }),
      Match.orElse(() => undefined),
    );

    if (response !== undefined) return response;
  }

  return nativeProblemResponse("identity.unavailable", 503);
};

/**
 * Session mutations answer the frozen command table: an identity engine
 * failure is an unavailable dependency, and the receipt failures are answered
 * as every native command answers them.
 */
const sessionMutationErrorResponse = (cause: unknown): Response => {
  if (Predicate.isTagged(cause, "NativeHttpReceiptPersistenceError")) {
    return isSerializationConflict(cause)
      ? nativeProblemResponse("transaction.conflict", 409)
      : nativeProblemResponse("idempotency.unavailable", 503);
  }

  if (Predicate.isTagged(cause, "NativeHttpReceiptInvalid")) {
    return nativeProblemResponse("internal.error", 500);
  }

  if (cause instanceof IdentityEngineError) {
    return nativeProblemResponse("dependency.unavailable", 503);
  }

  return identityErrorResponse(cause);
};

const projection = (personId: string, session: IdentitySession) => ({
  sessionId: session.sessionId,
  personId,
  createdAt: DateTime.toDateUtc(session.createdAt).toISOString(),
  updatedAt: DateTime.toDateUtc(session.updatedAt).toISOString(),
  expiresAt: DateTime.toDateUtc(session.expiresAt).toISOString(),
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
  current: session.current,
});

const identityOperation = <A>(
  operation: (identity: IdentityOperations) => Promise<A>,
): Effect.Effect<
  A,
  | IdentityEngineError
  | IdentitySessionNotFound
  | IdentitySessionExpired
  | IdentityOwnedSessionNotFound,
  Identity
> =>
  Identity.use((identity) =>
    Effect.tryPromise({
      try: () => operation(identity),
      catch: (cause) =>
        cause instanceof IdentityEngineError ||
        cause instanceof IdentitySessionNotFound ||
        cause instanceof IdentitySessionExpired ||
        cause instanceof IdentityOwnedSessionNotFound
          ? cause
          : new IdentityEngineError({
              operation: "nativeSessionResource",
              message: cause instanceof Error ? cause.message : "identity provider failure",
            }),
    }),
  );

const noQuery = (request: Request): Effect.Effect<void, HttpSemanticFailure> =>
  new URL(request.url).search === ""
    ? Effect.void
    : Effect.fail(new HttpSemanticFailure("request.malformed", 400));

interface SystemOptions {
  readonly now?: () => string;
}

const principalFor = (request: Request, options: SystemOptions) =>
  resolveAuthenticatedPersonAtInstant(request.headers.get("cookie") ?? undefined, {
    now: options.now,
  });

const authorizeSessionOperation = (input: {
  readonly request: Request;
  readonly principal: AuthenticatedPersonAtInstant;
  readonly endpoint: Parameters<typeof reflectAccessSpec>[0];
  readonly resourceId?: string;
  readonly collection?: boolean;
}) =>
  authorizePersonNativeOperation({
    spec: Option.getOrThrow(reflectAccessSpec(input.endpoint)),
    request: input.request,
    personId: input.principal.personId,
    resolution: {
      selection: input.collection === true ? "AllMatching" : "ExactlyOne",
      contexts: [
        genericContext({
          domainId: "identity",
          resourceKind: input.resourceId === undefined ? undefined : "identity-session",
          resourceId: input.resourceId,
          facts: { ownerPersonId: input.principal.personId },
          authorityVersion: `identity:${input.principal.authorizationInstant}`,
        }),
      ],
    },
    grantScopes: [Scope.Global()],
    now: input.principal.authorizationInstant,
  });

const executeSessionMutation = (input: {
  readonly request: Request;
  readonly options: SystemOptions;
  readonly endpoint: Parameters<typeof reflectAccessSpec>[0];
  readonly operationId: string;
  readonly normalizedTarget: string;
  readonly resourceId?: string;
  readonly mutate: (
    identity: IdentitySnapshotService,
    actor: IdentityActor,
  ) => Effect.Effect<
    unknown,
    IdentityEngineError | IdentitySessionNotFound | IdentityOwnedSessionNotFound,
    Database
  >;
}) =>
  Effect.gen(function* () {
    yield* noQuery(input.request);

    const idempotencyKey = parseIdempotencyKey(
      input.request.headers.get("idempotency-key") === null
        ? []
        : [input.request.headers.get("idempotency-key")!],
    );

    const result = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authenticated = yield* resolveRequestCredentialInTransaction(
          input.request,
          "OAuthUserBearer",
          { now: input.options.now },
        );

        const identity = yield* IdentitySnapshot;

        const actor = yield* identity.resolveSession(
          input.request.headers.get("cookie") ?? undefined,
          authenticated.authorizationInstant,
        );

        yield* authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(input.endpoint)),
          credential: authenticated.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "identity",
                resourceKind: input.resourceId === undefined ? undefined : "identity-session",
                resourceId: input.resourceId,
                facts: { ownerPersonId: actor.personId },
                authorityVersion: `identity:${authenticated.authorizationInstant}`,
              }),
            ],
          },
          grantScopes: [Scope.Global()],
          now: authenticated.authorizationInstant,
        });

        const derived = deriveHttpIdentity({
          credentialSubject: `Person:${actor.personId}`,
          qualifiedOperationId: input.operationId,
          normalizedTarget: input.normalizedTarget,
          idempotencyKey,
        });

        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest({}),
            operationId: input.operationId,
          },
          execute: input.mutate(identity, actor).pipe(
            Effect.as({
              status: 204,
              mediaType: null,
              headers: {},
              bodyBytes: null,
            }),
          ),
        };
      }),
    );

    return nativeCommandOutcomeResponse(result);
  });

/** Native HttpApi implementations for health and the six frozen session resources. */
export const SystemApiHandlers = (options: SystemOptions = {}) =>
  HttpApiBuilder.group(ExternalNativeApi, "system", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("health", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              Effect.gen(function* () {
                yield* noQuery(webRequest);
                yield* authorizeAnonymousNativeOperation(
                  Option.getOrThrow(reflectAccessSpec(HealthEndpoint)),
                  {
                    selection: "ExactlyOne",
                    contexts: [
                      genericContext({
                        domainId: "system",
                        authorityVersion: "system-health",
                      }),
                    ],
                  },
                  options.now === undefined
                    ? DateTime.formatIso(yield* DateTime.now)
                    : options.now(),
                );
                yield* databaseHealth;

                return jsonResponse({ status: "ok" }, "no-store");
              }),
            (cause) =>
              cause instanceof HttpSemanticFailure
                ? nativeProblemResponse(cause.code, cause.status)
                : nativeProblemResponse("health.unavailable", 503),
          ),
        )
        .handleRaw("readSession", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              Effect.gen(function* () {
                yield* noQuery(webRequest);
                const principal = yield* principalFor(webRequest, options);

                const session = yield* identityOperation((identity) =>
                  identity.readCurrentSession(webRequest.headers.get("cookie") ?? undefined),
                );

                yield* authorizeSessionOperation({
                  request: webRequest,
                  principal,
                  endpoint: ReadSessionEndpoint,
                  resourceId: session.sessionId,
                });

                return jsonResponse(projection(principal.personId, session), "private, no-store");
              }),
            identityErrorResponse,
          ),
        )
        .handleRaw("deleteSession", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              executeSessionMutation({
                request: webRequest,
                options,
                endpoint: DeleteSessionEndpoint,
                operationId: "system.deleteSession",
                normalizedTarget: "/api/session",
                mutate: (identity, actor) =>
                  identity.revokeCurrentSession(actor, identityRequestContext(webRequest)),
              }),
            sessionMutationErrorResponse,
          ),
        )
        .handleRaw("listSessions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              Effect.gen(function* () {
                yield* noQuery(webRequest);
                const principal = yield* principalFor(webRequest, options);
                yield* authorizeSessionOperation({
                  request: webRequest,
                  principal,
                  endpoint: ListSessionsEndpoint,
                  collection: true,
                });

                const sessions = yield* identityOperation((identity) =>
                  identity.listSessions(webRequest.headers.get("cookie") ?? undefined),
                );

                return jsonResponse(
                  sessions.map((session) => projection(principal.personId, session)),
                  "private, no-store",
                );
              }),
            identityErrorResponse,
          ),
        )
        .handleRaw("deleteOwnedSession", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              executeSessionMutation({
                request: webRequest,
                options,
                endpoint: DeleteOwnedSessionEndpoint,
                operationId: "system.deleteOwnedSession",
                normalizedTarget: `/api/sessions/${encodePathIdentity(params.sessionId)}`,
                resourceId: params.sessionId,
                mutate: (identity, actor) =>
                  identity.revokeSession(
                    actor,
                    params.sessionId,
                    identityRequestContext(webRequest),
                  ),
              }),
            sessionMutationErrorResponse,
          ),
        )
        .handleRaw("revokeOtherSessions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              executeSessionMutation({
                request: webRequest,
                options,
                endpoint: RevokeOtherSessionsEndpoint,
                operationId: "system.revokeOtherSessions",
                normalizedTarget: "/api/sessions::revoke-others",
                mutate: (identity, actor) =>
                  identity.revokeOtherSessions(actor, identityRequestContext(webRequest)),
              }),
            sessionMutationErrorResponse,
          ),
        )
        .handleRaw("revokeAllSessions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              executeSessionMutation({
                request: webRequest,
                options,
                endpoint: RevokeAllSessionsEndpoint,
                operationId: "system.revokeAllSessions",
                normalizedTarget: "/api/sessions::revoke-all",
                mutate: (identity, actor) =>
                  identity.revokeAllSessions(actor, identityRequestContext(webRequest)),
              }),
            sessionMutationErrorResponse,
          ),
        ),
    ),
  );
