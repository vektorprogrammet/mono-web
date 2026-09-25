import { Scope } from "@vektorprogrammet/domain/authz";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
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
import {
  type CredentialPresentation,
  nativeCookieChallenge,
  Problem,
} from "@vektorprogrammet/http-api/http-semantics";
import { Schema, DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  resolveAuthenticatedPersonAtInstant,
  resolveRequestCredentialInTransaction,
  type AuthenticatedPersonAtInstant,
} from "../authority.js";
import { encodePathIdentity, semanticRequestDigest } from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { identityRequestContext } from "../session-security.js";
import {
  authorizeAnonymous,
  authorizePerson,
  commandOutcomeResponse,
  commandReceiptProblems,
  httpIdentity,
  idempotencyKeyOf,
  personPresentation,
  problemMapper,
  requireNoQuery,
  unreachable,
  webHandler,
} from "./problem.js";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpResponseCapsule,
} from "./receipt-transaction.js";

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

/** A session resource is secured by the session cookie alone, so it challenges only that scheme. */
const sessionPresentation = (request: Request) =>
  personPresentation(request, nativeCookieChallenge);

/**
 * The one answer for every identity failure of a session resource. A rejected
 * session is answered from the request's evidence; an identity engine failure
 * is the operation's own unavailability problem.
 */
const sessionProblems = <
  const Unavailable extends Problem<"identity.unavailable"> | Problem<"dependency.unavailable">,
>(
  presentation: CredentialPresentation,
  unavailable: Unavailable,
) =>
  problemMapper<
    | IdentityEngineError
    | IdentitySessionNotFound
    | IdentitySessionExpired
    | IdentityOwnedSessionNotFound
    | UnauthenticatedActor
  >()({
    IdentityEngineError: () => unavailable,
    IdentitySessionNotFound: () => Problem.unauthenticated(presentation),
    IdentitySessionExpired: () => Problem.unauthenticated(presentation),
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityOwnedSessionNotFound: () => Problem.make("resource.not-found"),
  });

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

interface SystemOptions {
  readonly now?: () => string;
}

const principalFor = (request: Request, options: SystemOptions) =>
  resolveAuthenticatedPersonAtInstant(request.headers.get("cookie") ?? undefined, {
    now: options.now,
  });

const authorizeSessionOperation = (
  input: {
    readonly request: Request;
    readonly principal: AuthenticatedPersonAtInstant;
    readonly endpoint: Parameters<typeof reflectAccessSpec>[0];
    readonly resourceId?: string;
    readonly collection?: boolean;
  },
  presentation: CredentialPresentation,
) =>
  authorizePerson(
    {
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
    },
    presentation,
  );

const health = (request: Request, options: SystemOptions) =>
  Effect.gen(function* () {
    yield* requireNoQuery(request);
    yield* authorizeAnonymous(
      Option.getOrThrow(reflectAccessSpec(HealthEndpoint)),
      {
        selection: "ExactlyOne",
        contexts: [genericContext({ domainId: "system", authorityVersion: "system-health" })],
      },
      options.now === undefined ? DateTime.formatIso(yield* DateTime.now) : options.now(),
    );
    yield* databaseHealth.pipe(Effect.mapError(() => Problem.make("health.unavailable")));

    return jsonResponse({ status: "ok" }, "no-store");
  });

const readSession = (request: Request, options: SystemOptions) => {
  const presentation = sessionPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);
    const principal = yield* principalFor(request, options);

    const session = yield* identityOperation((identity) =>
      identity.readCurrentSession(request.headers.get("cookie") ?? undefined),
    );

    yield* authorizeSessionOperation(
      { request, principal, endpoint: ReadSessionEndpoint, resourceId: session.sessionId },
      presentation,
    );

    return jsonResponse(projection(principal.personId, session), "private, no-store");
  }).pipe(
    sessionProblems(presentation, Problem.make("identity.unavailable")),
    // The owner is granted their own session; only a mismatched credential is rejected.
    unreachable("authority.denied", "resource.not-found"),
  );
};

const listSessions = (request: Request, options: SystemOptions) => {
  const presentation = sessionPresentation(request);

  return Effect.gen(function* () {
    yield* requireNoQuery(request);
    const principal = yield* principalFor(request, options);

    yield* authorizeSessionOperation(
      { request, principal, endpoint: ListSessionsEndpoint, collection: true },
      presentation,
    );

    const sessions = yield* identityOperation((identity) =>
      identity.listSessions(request.headers.get("cookie") ?? undefined),
    );

    return jsonResponse(
      sessions.map((session) => projection(principal.personId, session)),
      "private, no-store",
    );
  }).pipe(
    sessionProblems(presentation, Problem.make("identity.unavailable")),
    // The owner is granted their own sessions; only a mismatched credential is rejected.
    unreachable("authority.denied", "resource.not-found"),
  );
};

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
}) => {
  const presentation = sessionPresentation(input.request);

  return Effect.gen(function* () {
    yield* requireNoQuery(input.request);

    const idempotencyKey = yield* idempotencyKeyOf(input.request);

    const outcome = yield* executeNativeHttpCommandPostgres(
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

        yield* authorizePerson(
          {
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
          },
          presentation,
        );

        const derived = yield* httpIdentity({
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
            Effect.as<NativeHttpResponseCapsule>({
              status: 204,
              mediaType: null,
              headers: {},
              bodyBytes: null,
            }),
          ),
        };
      }),
    ).pipe(
      // The frozen command table answers an identity engine failure as an unavailable dependency.
      sessionProblems(presentation, Problem.make("dependency.unavailable")),
      commandReceiptProblems,
    );

    return yield* commandOutcomeResponse(outcome);
  });
};

/** Native HttpApi implementations for health and the six frozen session resources. */
export const SystemApiHandlers = (options: SystemOptions = {}) =>
  HttpApiBuilder.group(ExternalNativeApi, "system", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("health", ({ request }) =>
          webHandler(request, (webRequest) => health(webRequest, options)),
        )
        .handleRaw("readSession", ({ request }) =>
          webHandler(request, (webRequest) => readSession(webRequest, options)),
        )
        .handleRaw("deleteSession", ({ request }) =>
          webHandler(request, (webRequest) =>
            executeSessionMutation({
              request: webRequest,
              options,
              endpoint: DeleteSessionEndpoint,
              operationId: "system.deleteSession",
              normalizedTarget: "/api/session",
              mutate: (identity, actor) =>
                identity.revokeCurrentSession(actor, identityRequestContext(webRequest)),
            }).pipe(
              // Only the owned-session delete names a session other than the caller's own.
              unreachable("resource.not-found"),
            ),
          ),
        )
        .handleRaw("listSessions", ({ request }) =>
          webHandler(request, (webRequest) => listSessions(webRequest, options)),
        )
        .handleRaw("deleteOwnedSession", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            executeSessionMutation({
              request: webRequest,
              options,
              endpoint: DeleteOwnedSessionEndpoint,
              operationId: "system.deleteOwnedSession",
              normalizedTarget: `/api/sessions/${encodePathIdentity(params.sessionId)}`,
              resourceId: params.sessionId,
              mutate: (identity, actor) =>
                identity.revokeSession(actor, params.sessionId, identityRequestContext(webRequest)),
            }),
          ),
        )
        .handleRaw("revokeOtherSessions", ({ request }) =>
          webHandler(request, (webRequest) =>
            executeSessionMutation({
              request: webRequest,
              options,
              endpoint: RevokeOtherSessionsEndpoint,
              operationId: "system.revokeOtherSessions",
              normalizedTarget: "/api/sessions::revoke-others",
              mutate: (identity, actor) =>
                identity.revokeOtherSessions(actor, identityRequestContext(webRequest)),
            }).pipe(
              // Only the owned-session delete names a session other than the caller's own.
              unreachable("resource.not-found"),
            ),
          ),
        )
        .handleRaw("revokeAllSessions", ({ request }) =>
          webHandler(request, (webRequest) =>
            executeSessionMutation({
              request: webRequest,
              options,
              endpoint: RevokeAllSessionsEndpoint,
              operationId: "system.revokeAllSessions",
              normalizedTarget: "/api/sessions::revoke-all",
              mutate: (identity, actor) =>
                identity.revokeAllSessions(actor, identityRequestContext(webRequest)),
            }).pipe(
              // Only the owned-session delete names a session other than the caller's own.
              unreachable("resource.not-found"),
            ),
          ),
        ),
    ),
  );
