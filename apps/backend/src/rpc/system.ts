/**
 * The SystemRpcs handlers: the caller's first-party session and session management.
 *
 * Every session RPC takes the session cookie alone. A read authenticates the session and
 * evaluates the AccessSpec over the caller's own session; a command resolves the credential and
 * the session inside the serializable transaction that commits it, and stores its no-content
 * answer as a command receipt, so a retry with the same idempotency key replays it.
 */
import { IdentitySnapshot, type Database, type IdentitySnapshotService } from "@vektorprogrammet/database";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { Scope } from "@vektorprogrammet/domain/authz";
import {
  Identity,
  type IdentityActor,
  type IdentityEngineError,
  type IdentityOwnedSessionNotFound,
  type IdentitySession,
  type IdentitySessionExpired,
  type IdentitySessionNotFound,
} from "@vektorprogrammet/domain/identity";
import type { PersonId } from "@vektorprogrammet/domain/organization";
import {
  DeleteOwnedSession,
  DeleteSession,
  ListSessions,
  ReadSession,
  RevokeAllSessions,
  RevokeOtherSessions,
  SystemRpcs,
  reflectAccessSpec,
  type SessionResponse,
} from "@vektorprogrammet/rpc";
import {
  type CredentialPresentation,
  type IdempotencyKey,
  nativeCookieChallenge,
  Problem,
} from "@vektorprogrammet/rpc/problem";
import { DateTime, Effect, Match, Option } from "effect";
import type { Headers } from "effect/unstable/http";
import type { Rpc } from "effect/unstable/rpc";
import {
  resolveAuthenticatedPersonAtInstant,
  resolveRequestCredentialInTransaction,
  type AuthenticatedPersonAtInstant,
} from "../authority.js";
import { encodePathIdentity, semanticRequestDigest } from "../http-semantics.js";
import { genericContext } from "../native-operation.js";
import { identityRequestContext } from "../session-security.js";
import { credentialRequestOf } from "./credential.js";
import type { NativeRpcOptions } from "./options.js";
import {
  authorizePerson,
  commandIdentity,
  commandReceiptProblems,
  personPresentation,
  problemMapper,
  unreachable,
} from "./problem.js";
import {
  executeNativeHttpCommandPostgres,
  type NativeHttpCommandOutcome,
  type NativeHttpResponseCapsule,
} from "./receipt-transaction.js";

/** A session resource is secured by the session cookie alone, so it challenges only that scheme. */
const sessionPresentation = (headers: Headers.Headers) =>
  personPresentation(headers, nativeCookieChallenge);

/**
 * The one answer for every identity failure of a session resource. A rejected session is answered
 * from the request's evidence; an identity engine failure is the operation's own unavailability
 * problem.
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

const projection = (personId: PersonId, session: IdentitySession): SessionResponse => ({
  sessionId: session.sessionId,
  personId,
  createdAt: DateTime.toDateUtc(session.createdAt).toISOString(),
  updatedAt: DateTime.toDateUtc(session.updatedAt).toISOString(),
  expiresAt: DateTime.toDateUtc(session.expiresAt).toISOString(),
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
  current: session.current,
});

const principalFor = (headers: Headers.Headers, options: NativeRpcOptions) =>
  resolveAuthenticatedPersonAtInstant(headers.cookie, { now: options.now });

const authorizeSessionRead = (input: {
  readonly headers: Headers.Headers;
  readonly principal: AuthenticatedPersonAtInstant;
  readonly rpc: Pick<Rpc.AnyWithProps, "annotations">;
  readonly resourceId?: string;
  readonly collection?: boolean;
}) =>
  authorizePerson(
    {
      spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
      request: credentialRequestOf(input.headers),
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
    sessionPresentation(input.headers),
  );

/** The receipt of a session command: the no-content answer the HTTP contract stored. */
const noContent: NativeHttpResponseCapsule = {
  status: 204,
  mediaType: null,
  headers: {},
  bodyBytes: null,
};

/**
 * A session command answers nothing: a committed or replayed receipt, whichever the HTTP contract
 * or the RPC stored, succeeds with no value, and every other outcome is its idempotency problem.
 */
const noContentOutcome = (outcome: NativeHttpCommandOutcome) =>
  Match.value(outcome).pipe(
    Match.tag("Committed", "Replay", () => Effect.void),
    Match.tag("InFlight", () => Effect.fail(Problem.make("idempotency.in-flight"))),
    Match.tag("DigestConflict", () => Effect.fail(Problem.make("idempotency.digest-conflict"))),
    Match.tag("ResponseExpired", () => Effect.fail(Problem.make("idempotency.response-expired"))),
    Match.exhaustive,
  );

const executeSessionCommand = (input: {
  readonly headers: Headers.Headers;
  readonly options: NativeRpcOptions;
  readonly rpc: Pick<Rpc.AnyWithProps, "annotations">;
  readonly operationId: string;
  readonly normalizedTarget: string;
  readonly idempotencyKey: IdempotencyKey;
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
  const presentation = sessionPresentation(input.headers);
  const request = credentialRequestOf(input.headers);

  return Effect.gen(function* () {
    // Failures are mapped after the executor, whose retry reads their causes.
    const outcome = yield* executeNativeHttpCommandPostgres(
      Effect.gen(function* () {
        const authenticated = yield* resolveRequestCredentialInTransaction(
          request,
          "OAuthUserBearer",
          { now: input.options.now },
        );

        const identity = yield* IdentitySnapshot;

        const actor = yield* identity.resolveSession(
          input.headers.cookie,
          authenticated.authorizationInstant,
        );

        yield* authorizePerson(
          {
            spec: Option.getOrThrow(reflectAccessSpec(input.rpc)),
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

        // The HTTP route stays the normalized target, so receipts and command IDs are stable.
        const derived = yield* commandIdentity({
          credentialSubject: `Person:${actor.personId}`,
          qualifiedOperationId: input.operationId,
          normalizedTarget: input.normalizedTarget,
          idempotencyKey: input.idempotencyKey,
        });

        return {
          identity: {
            identitySha256: derived.identitySha256,
            requestSha256: semanticRequestDigest({}),
            operationId: input.operationId,
          },
          execute: input.mutate(identity, actor).pipe(Effect.as(noContent)),
        };
      }),
    ).pipe(
      // The frozen command table answers an identity engine failure as an unavailable dependency.
      sessionProblems(presentation, Problem.make("dependency.unavailable")),
      commandReceiptProblems,
    );

    return yield* noContentOutcome(outcome);
  });
};

/** The SystemRpcs handlers. */
export const SystemRpcHandlers = (options: NativeRpcOptions) =>
  SystemRpcs.toLayer({
    "system.readSession": (_payload, { headers }) =>
      Effect.gen(function* () {
        const principal = yield* principalFor(headers, options);

        const session = yield* Identity.use(({ readCurrentSession }) =>
          readCurrentSession(headers.cookie),
        );

        yield* authorizeSessionRead({
          headers,
          principal,
          rpc: ReadSession,
          resourceId: session.sessionId,
        });

        return projection(principal.personId, session);
      }).pipe(
        sessionProblems(sessionPresentation(headers), Problem.make("identity.unavailable")),
        // The owner is granted their own session; only a mismatched credential is rejected.
        unreachable("authority.denied", "resource.not-found"),
      ),

    "system.listSessions": (_payload, { headers }) =>
      Effect.gen(function* () {
        const principal = yield* principalFor(headers, options);

        yield* authorizeSessionRead({ headers, principal, rpc: ListSessions, collection: true });

        const sessions = yield* Identity.use(({ listSessions }) => listSessions(headers.cookie));

        return sessions.map((session) => projection(principal.personId, session));
      }).pipe(
        sessionProblems(sessionPresentation(headers), Problem.make("identity.unavailable")),
        // The owner is granted their own sessions; only a mismatched credential is rejected.
        unreachable("authority.denied", "resource.not-found"),
      ),

    "system.deleteSession": ({ idempotencyKey }, { headers }) =>
      executeSessionCommand({
        headers,
        options,
        rpc: DeleteSession,
        operationId: "system.deleteSession",
        normalizedTarget: "/api/session",
        idempotencyKey,
        mutate: (identity, actor) =>
          identity.revokeCurrentSession(actor, identityRequestContext(credentialRequestOf(headers))),
      }).pipe(
        // Only the owned-session delete names a session other than the caller's own.
        unreachable("resource.not-found"),
      ),

    "system.deleteOwnedSession": ({ idempotencyKey, sessionId }, { headers }) =>
      executeSessionCommand({
        headers,
        options,
        rpc: DeleteOwnedSession,
        operationId: "system.deleteOwnedSession",
        normalizedTarget: `/api/sessions/${encodePathIdentity(sessionId)}`,
        idempotencyKey,
        resourceId: sessionId,
        mutate: (identity, actor) =>
          identity.revokeSession(
            actor,
            sessionId,
            identityRequestContext(credentialRequestOf(headers)),
          ),
      }),

    "system.revokeOtherSessions": ({ idempotencyKey }, { headers }) =>
      executeSessionCommand({
        headers,
        options,
        rpc: RevokeOtherSessions,
        operationId: "system.revokeOtherSessions",
        // The HTTP handler's target, verbatim, so receipts and command IDs stay stable.
        normalizedTarget: "/api/sessions::revoke-others",
        idempotencyKey,
        mutate: (identity, actor) =>
          identity.revokeOtherSessions(actor, identityRequestContext(credentialRequestOf(headers))),
      }).pipe(unreachable("resource.not-found")),

    "system.revokeAllSessions": ({ idempotencyKey }, { headers }) =>
      executeSessionCommand({
        headers,
        options,
        rpc: RevokeAllSessions,
        operationId: "system.revokeAllSessions",
        // The HTTP handler's target, verbatim, so receipts and command IDs stay stable.
        normalizedTarget: "/api/sessions::revoke-all",
        idempotencyKey,
        mutate: (identity, actor) =>
          identity.revokeAllSessions(actor, identityRequestContext(credentialRequestOf(headers))),
      }).pipe(unreachable("resource.not-found")),
  });
