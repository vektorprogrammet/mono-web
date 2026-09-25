import {
  ContactSsrSecurity,
  InvitationCapabilitySecurity,
  PersonOrServiceSecurity,
  PersonSecurity,
  RequestSchemaErrorMiddleware,
  SessionSecurity,
} from "@vektorprogrammet/http-api";
import { timingSafeEqual } from "node:crypto";
import { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { CONTACT_BACKEND_HEADER } from "@vektorprogrammet/domain/contact";
import { Identity } from "@vektorprogrammet/domain/identity";
import { credentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Match, Effect, Layer, Redacted, Result, type SchemaIssue } from "effect";
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi";
import {
  resolveAuthenticatedPerson,
  resolveAuthenticatedSession,
  resolveRequestCredentialAtInstant,
  resolveRequestPerson,
} from "../authority.js";
import type { ContactConfig } from "../contact/config.js";
import { classifyCredential, problemWebResponse } from "./problem.js";

/**
 * Flattens one Effect-native Web transport operation into an HTTP API response.
 * The caller supplies the group's frozen error translation while the handler's
 * service requirements remain visible to the enclosing HttpApiBuilder Layer.
 */
export const toHttpApiResponse = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  handle: (request: Request) => Effect.Effect<Response, E, R>,
  mapError: (cause: E | HttpServerError.RequestError) => Response,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap(handle),
    Effect.catch((cause) => Effect.succeed(mapError(cause))),
    Effect.map(HttpServerResponse.fromWeb),
  );

const issueAtHeader = (
  issue: SchemaIssue.Issue,
  headerName: string,
  leafTag?: SchemaIssue.Leaf["_tag"],
  path: ReadonlyArray<PropertyKey> = [],
): boolean => {
  return Match.value(issue).pipe(
    Match.tag("Filter", "Encoding", (issue) => {
      return issueAtHeader(issue.issue, headerName, leafTag, path);
    }),
    Match.tag("Pointer", (issue) => {
      return issueAtHeader(issue.issue, headerName, leafTag, [...path, ...issue.path]);
    }),
    Match.tag("Composite", "AnyOf", (issue) => {
      return issue.issues.some((nested) => issueAtHeader(nested, headerName, leafTag, path));
    }),
    Match.orElse((issue) => {
      return (
        path.some((segment) => segment === headerName) &&
        (leafTag === undefined || issue._tag === leafTag)
      );
    }),
  );
};

/** Maps automatic request decoding failures to the frozen transport problem families. */
const requestSchemaProblem = (error: HttpApiError.HttpApiSchemaError) => {
  if (error.kind === "Headers") {
    if (issueAtHeader(error.cause.issue, "if-match")) {
      return issueAtHeader(error.cause.issue, "if-match", "MissingKey")
        ? Problem.make("precondition.required")
        : Problem.make("precondition.invalid");
    }

    if (issueAtHeader(error.cause.issue, "if-none-match")) {
      return Problem.make("precondition.invalid");
    }

    if (issueAtHeader(error.cause.issue, "idempotency-key")) {
      return Problem.make("idempotency-key.invalid");
    }

    return Problem.make("header.malformed");
  }

  if (error.kind === "Params" || error.kind === "Query") {
    return Problem.make("request.malformed");
  }

  return Problem.make("internal.error");
};

/**
 * RequestSchemaErrorMiddleware is API-wide, so it declares no error that would
 * spread to every endpoint. It answers with the rendering the encoder uses.
 */
export const requestSchemaErrorResponse = (error: HttpApiError.HttpApiSchemaError): Response =>
  problemWebResponse(requestSchemaProblem(error));

type CredentialChallenge =
  | 'VektorSession realm="native-api"'
  | 'VektorSession realm="native-api", Bearer realm="native-api"';

/**
 * Rejects a failed person or session authentication from the raw request.
 * Effect decodes an absent credential as an empty value, so absence is read
 * from the headers: no Better Auth session cookie and no Authorization header
 * is a missing credential; any presented credential that failed is invalid.
 */
const rejectCredential = (
  request: HttpServerRequest.HttpServerRequest,
  challenge: CredentialChallenge,
) =>
  Effect.fail(
    Problem.unauthenticated(
      classifyCredential(request.headers.authorization, request.headers.cookie, challenge),
    ),
  );

const isUnauthenticated = (cause: unknown): cause is UnauthenticatedActor =>
  cause instanceof UnauthenticatedActor;

const sessionSecurityLayer = Layer.effect(
  SessionSecurity,
  Effect.map(Identity, (identity) =>
    SessionSecurity.of({
      cookieHeader: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const authentication = yield* Effect.result(
            resolveAuthenticatedSession(Redacted.value(credential)).pipe(
              Effect.provideService(Identity, identity),
            ),
          );

          if (Result.isFailure(authentication) && isUnauthenticated(authentication.failure)) {
            return yield* rejectCredential(
              yield* HttpServerRequest.HttpServerRequest,
              'VektorSession realm="native-api"',
            );
          }

          return yield* httpEffect;
        }),
    }),
  ),
);

const personSecurityLayer = Layer.effect(
  PersonSecurity,
  Effect.gen(function* () {
    const identity = yield* Identity;
    const oauthCredentialAuthority = yield* OAuthCredentialAuthority;

    return PersonSecurity.of({
      cookieHeader: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const cookieHeader = Redacted.value(credential);
          const request = yield* HttpServerRequest.HttpServerRequest;

          const webRequest = new Request(new URL(request.url, "http://native-api.invalid"), {
            method: request.method,
            headers: request.headers,
          });

          const authentication = yield* Effect.result(
            request.headers.authorization !== undefined
              ? resolveRequestPerson(webRequest).pipe(
                  Effect.provideService(Identity, identity),
                  Effect.provideService(OAuthCredentialAuthority, oauthCredentialAuthority),
                )
              : resolveAuthenticatedPerson(cookieHeader).pipe(
                  Effect.provideService(Identity, identity),
                ),
          );

          if (Result.isFailure(authentication) && isUnauthenticated(authentication.failure)) {
            return yield* rejectCredential(
              request,
              'VektorSession realm="native-api", Bearer realm="native-api"',
            );
          }

          return yield* httpEffect;
        }),
      oauthUserBearer: (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;

          const webRequest = new Request(new URL(request.url, "http://native-api.invalid"), {
            method: request.method,
            headers: request.headers,
          });

          const authentication = yield* Effect.result(
            resolveRequestPerson(webRequest).pipe(
              Effect.provideService(Identity, identity),
              Effect.provideService(OAuthCredentialAuthority, oauthCredentialAuthority),
            ),
          );

          if (Result.isFailure(authentication) && isUnauthenticated(authentication.failure)) {
            return yield* rejectCredential(
              request,
              'VektorSession realm="native-api", Bearer realm="native-api"',
            );
          }

          return yield* httpEffect;
        }),
    });
  }),
);

const personOrServiceSecurityLayer = Layer.effect(
  PersonOrServiceSecurity,
  Effect.gen(function* () {
    const identity = yield* Identity;
    const oauthCredentialAuthority = yield* OAuthCredentialAuthority;

    const authenticate = <A, E, R>(httpEffect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        const webRequest = new Request(new URL(request.url, "http://native-api.invalid"), {
          method: request.method,
          headers: request.headers,
        });

        const authentication = yield* Effect.result(
          resolveRequestCredentialAtInstant(webRequest, "Either").pipe(
            Effect.provideService(Identity, identity),
            Effect.provideService(OAuthCredentialAuthority, oauthCredentialAuthority),
          ),
        );

        if (Result.isFailure(authentication) && isUnauthenticated(authentication.failure)) {
          return yield* rejectCredential(
            request,
            'VektorSession realm="native-api", Bearer realm="native-api"',
          );
        }

        return yield* httpEffect;
      });

    return PersonOrServiceSecurity.of({
      cookieHeader: authenticate,
      oauthUserBearer: authenticate,
      oauthServiceBearer: authenticate,
    });
  }),
);

const invitationCapabilitySecurityLayer = Layer.succeed(
  InvitationCapabilitySecurity,
  InvitationCapabilitySecurity.of({
    invitationCapability: (httpEffect, { credential }) =>
      Redacted.value(credential).length === 0
        ? Effect.fail(Problem.make("resource.not-found"))
        : httpEffect,
  }),
);

const contactSsrSecurityLayer = (contact: ContactConfig | undefined) => {
  const expected = contact === undefined ? undefined : Buffer.from(contact.backendToken);

  return Layer.succeed(
    ContactSsrSecurity,
    ContactSsrSecurity.of({
      contactBackend: (httpEffect, { credential }) => {
        if (expected === undefined) return httpEffect;
        const supplied = Buffer.from(Redacted.value(credential));

        // A request without the header presented no credential; a wrong token presented an invalid one.
        return supplied.length === expected.length && timingSafeEqual(supplied, expected)
          ? httpEffect
          : Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
              Effect.fail(
                Problem.unauthenticated(
                  credentialPresentation({
                    presented: request.headers[CONTACT_BACKEND_HEADER] !== undefined,
                    challenge: 'ContactSSR realm="native-contact"',
                  }),
                ),
              ),
            );
      },
    }),
  );
};

const RequestSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestSchemaErrorMiddleware,
  (error) => Effect.succeed(HttpServerResponse.fromWeb(requestSchemaErrorResponse(error))),
);

/**
 * Implements declared transport security at ingress. Domain handlers retain
 * transaction-scoped authorization so command authority is re-evaluated under
 * the serializable transaction that commits the command.
 */
export const nativeHttpApiMiddlewareLayer = (contact?: ContactConfig) =>
  Layer.mergeAll(
    contactSsrSecurityLayer(contact),
    sessionSecurityLayer,
    personSecurityLayer,
    personOrServiceSecurityLayer,
    invitationCapabilitySecurityLayer,
    RequestSchemaErrorLive,
  );

/** Shared default for focused contract tests without configured contact delivery. */
export const NativeHttpApiMiddlewareLive = nativeHttpApiMiddlewareLayer();
