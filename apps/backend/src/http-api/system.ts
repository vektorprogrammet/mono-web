import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { IdentitySnapshot, type IdentitySnapshotService } from "@vektorprogrammet/database";
import { databaseHealth, type Database } from "@vektorprogrammet/domain/database";
import {
  Identity,
  IdentityEngineError,
  IdentityOwnedSessionNotFound,
  IdentitySessionExpired,
  IdentitySessionNotFound,
  type IdentityActor,
  type IdentitySession,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import { executeNativeHttpCommandPostgres } from "@vektorprogrammet/domain/http-semantics";
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
import { DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  resolveAuthenticatedPersonAtInstant,
  resolveRequestCredentialInTransaction,
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
  prepareNativeHttpCommand,
} from "../native-operation.js";
import type { BackendRun } from "../router.js";
import { identityRequestContext } from "../session-security.js";
import { toHttpApiResponse } from "./transport.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
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
  if (cause !== null && typeof cause === "object" && "_tag" in cause) {
    switch (cause._tag) {
      case "NativeHttpReceiptInFlightError":
        return nativeProblemResponse("idempotency.in-flight", 409, { "retry-after": "1" });
      case "NativeHttpReceiptDigestConflictError":
        return nativeProblemResponse("idempotency.digest-conflict", 409);
      case "NativeHttpReceiptExpiredError":
        return nativeProblemResponse("idempotency.response-expired", 409);
      case "NativeHttpReceiptPersistenceError":
        return nativeProblemResponse("idempotency.unavailable", 503);
    }
  }
  return nativeProblemResponse("identity.unavailable", 503);
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

const identityPromise = <A>(
  run: BackendRun,
  operation: (identity: IdentityShape) => Promise<A>,
): Promise<A> =>
  run(
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
    ),
  );

const noQuery = (request: Request): void => {
  if (new URL(request.url).search !== "") {
    throw new HttpSemanticFailure("request.malformed", 400);
  }
};

interface SystemOptions {
  readonly now?: () => string;
}

const principalFor = (request: Request, run: BackendRun, options: SystemOptions) =>
  resolveAuthenticatedPersonAtInstant(request.headers.get("cookie") ?? undefined, {
    run,
    now: options.now,
  });

const authorizeSessionOperation = async (input: {
  readonly request: Request;
  readonly run: BackendRun;
  readonly principal: Awaited<ReturnType<typeof principalFor>>;
  readonly endpoint: Parameters<typeof reflectAccessSpec>[0];
  readonly resourceId?: string;
  readonly collection?: boolean;
}): Promise<void> =>
  authorizePersonNativeOperation({
    spec: Option.getOrThrow(reflectAccessSpec(input.endpoint)),
    request: input.request,
    personId: input.principal.personId,
    resolution: {
      selection: input.collection === true ? "AllMatching" : "ExactlyOne",
      contexts: [
        genericContext({
          domainId: "identity",
          ...(input.resourceId === undefined
            ? {}
            : { resourceKind: "identity-session", resourceId: input.resourceId }),
          facts: { ownerPersonId: input.principal.personId },
          authorityVersion: `identity:${input.principal.authorizationInstant}`,
        }),
      ],
    },
    grantScopes: [{ _tag: "Global" }],
    now: input.principal.authorizationInstant,
    run: input.run,
  });

const executeSessionMutation = async (input: {
  readonly request: Request;
  readonly run: BackendRun;
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
}): Promise<Response> => {
  noQuery(input.request);
  const idempotencyKey = parseIdempotencyKey(
    input.request.headers.get("idempotency-key") === null
      ? []
      : [input.request.headers.get("idempotency-key")!],
  );
  const credentialHeaders = new Headers(input.request.headers);
  credentialHeaders.delete("authorization");
  const cookieRequest = new Request(input.request.url, {
    method: input.request.method,
    headers: credentialHeaders,
  });
  const result = await input.run(
    executeNativeHttpCommandPostgres(
      prepareNativeHttpCommand(input.run, async (txRun) => {
        const authenticated = await resolveRequestCredentialInTransaction(
          cookieRequest,
          "OAuthUserBearer",
          {
            run: txRun,
            now: input.options.now,
          },
        );
        const actor = await txRun(
          IdentitySnapshot.use(({ resolveSession }) =>
            resolveSession(
              input.request.headers.get("cookie") ?? undefined,
              authenticated.authorizationInstant,
            ),
          ),
        );
        await authorizePersonNativeOperation({
          spec: Option.getOrThrow(reflectAccessSpec(input.endpoint)),
          credential: authenticated.credential,
          personId: actor.personId,
          resolution: {
            selection: "ExactlyOne",
            contexts: [
              genericContext({
                domainId: "identity",
                ...(input.resourceId === undefined
                  ? {}
                  : { resourceKind: "identity-session", resourceId: input.resourceId }),
                facts: { ownerPersonId: actor.personId },
                authorityVersion: `identity:${authenticated.authorizationInstant}`,
              }),
            ],
          },
          grantScopes: [{ _tag: "Global" }],
          now: authenticated.authorizationInstant,
          run: txRun,
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
          execute: IdentitySnapshot.use((identity) =>
            Effect.map(input.mutate(identity, actor), () => ({
              status: 204,
              mediaType: null,
              headers: {},
              bodyBytes: null,
            })),
          ),
        };
      }),
    ),
  );
  return nativeCommandOutcomeResponse(result);
};

/** Native HttpApi implementations for health and the six frozen session resources. */
export const SystemApiHandlers = (run: BackendRun, options: SystemOptions = {}) =>
  HttpApiBuilder.group(ExternalNativeApi, "system", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("health", ({ request }) =>
          toHttpApiResponse(
            request,
            async (webRequest) => {
              noQuery(webRequest);
              await authorizeAnonymousNativeOperation(
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
                (options.now ?? (() => new Date().toISOString()))(),
                run,
              );
              await run(databaseHealth);
              return jsonResponse({ status: "ok" });
            },
            (cause) =>
              cause instanceof HttpSemanticFailure
                ? nativeProblemResponse(cause.code, cause.status)
                : nativeProblemResponse("health.unavailable", 503),
          ),
        )
        .handleRaw("readSession", ({ request }) =>
          toHttpApiResponse(
            request,
            async (webRequest) => {
              noQuery(webRequest);
              const principal = await principalFor(webRequest, run, options);
              const session = await identityPromise(run, (identity) =>
                identity.readCurrentSession(webRequest.headers.get("cookie") ?? undefined),
              );
              await authorizeSessionOperation({
                request: webRequest,
                run,
                principal,
                endpoint: ReadSessionEndpoint,
                resourceId: session.sessionId,
              });
              return jsonResponse(projection(principal.personId, session));
            },
            identityErrorResponse,
          ),
        )
        .handleRaw("deleteSession", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              executeSessionMutation({
                request: webRequest,
                run,
                options,
                endpoint: DeleteSessionEndpoint,
                operationId: "system.deleteSession",
                normalizedTarget: "/api/session",
                mutate: (identity, actor) =>
                  identity.revokeCurrentSession(actor, identityRequestContext(webRequest)),
              }),
            identityErrorResponse,
          ),
        )
        .handleRaw("listSessions", ({ request }) =>
          toHttpApiResponse(
            request,
            async (webRequest) => {
              noQuery(webRequest);
              const principal = await principalFor(webRequest, run, options);
              await authorizeSessionOperation({
                request: webRequest,
                run,
                principal,
                endpoint: ListSessionsEndpoint,
                collection: true,
              });
              const sessions = await identityPromise(run, (identity) =>
                identity.listSessions(webRequest.headers.get("cookie") ?? undefined),
              );
              return jsonResponse(
                sessions.map((session) => projection(principal.personId, session)),
              );
            },
            identityErrorResponse,
          ),
        )
        .handleRaw("deleteOwnedSession", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              executeSessionMutation({
                request: webRequest,
                run,
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
            identityErrorResponse,
          ),
        )
        .handleRaw("revokeOtherSessions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              executeSessionMutation({
                request: webRequest,
                run,
                options,
                endpoint: RevokeOtherSessionsEndpoint,
                operationId: "system.revokeOtherSessions",
                normalizedTarget: "/api/sessions::revoke-others",
                mutate: (identity, actor) =>
                  identity.revokeOtherSessions(actor, identityRequestContext(webRequest)),
              }),
            identityErrorResponse,
          ),
        )
        .handleRaw("revokeAllSessions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) =>
              executeSessionMutation({
                request: webRequest,
                run,
                options,
                endpoint: RevokeAllSessionsEndpoint,
                operationId: "system.revokeAllSessions",
                normalizedTarget: "/api/sessions::revoke-all",
                mutate: (identity, actor) =>
                  identity.revokeAllSessions(actor, identityRequestContext(webRequest)),
              }),
            identityErrorResponse,
          ),
        ),
    ),
  );
