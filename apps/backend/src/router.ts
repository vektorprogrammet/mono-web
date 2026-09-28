import { BlockList, isIP } from "node:net";
import { databaseHealth, type AuthEngineService } from "@vektorprogrammet/database";
import { CONTACT_BACKEND_HEADER, CONTACT_IP_HEADER } from "@vektorprogrammet/domain/contact";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import { RECEIPT_FILE_MAX_BYTES } from "@vektorprogrammet/domain/receipt";
import {
  InternalNativeRpcs,
  internalNativeRpcPath,
  isInternalNativeRpcPath,
  isNativeRpcPath,
  NativeRpcs,
  nativeRpcPath,
} from "@vektorprogrammet/rpc";
import { Problem, problemBody, problemHeaders } from "@vektorprogrammet/rpc/problem";
import { Effect, Layer, Option, Predicate, Schema } from "effect";
import { dual } from "effect/Function";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { AdmissionsRpcHandlers } from "./admission/rpc.js";
import { AdmissionOutcomesRpcHandlers } from "./admission/outcome-rpc.js";
import { ContactRpcHandlers } from "./contact/rpc.js";
import { ContentRpcHandlers } from "./content/rpc.js";
import { DirectoryRpcHandlers } from "./directory/rpc.js";
import { allowHeader } from "./http-semantics.js";
import { decideNativePreflight } from "./native-preflight.js";
import { OnboardingRpcHandlers } from "./onboarding/rpc.js";
import { OrganizationRpcHandlers } from "./organization/rpc.js";
import { CertificatesRpcHandlers } from "./placements/certificates-rpc.js";
import { PlacementsRpcHandlers } from "./placements/rpc.js";
import { ProfileRpcHandlers } from "./profile/rpc.js";
import { InternalReceiptsRpcHandlers, ReceiptsRpcHandlers } from "./receipt/rpc.js";
import { RecruitmentRpcHandlers } from "./recruitment/rpc.js";
import { nativeRpcCredentialLayer } from "./rpc/credential.js";
import type { NativeRpcOptions } from "./rpc/options.js";
import { ProblemBoundaryLive } from "./rpc/problem.js";
import { readBoundedJson } from "./rpc/read-json.js";
import { SystemRpcHandlers } from "./rpc/system.js";
import {
  allowsNativePreflightHeaders,
  decideTrustedOrigin,
  prepareIdentityBoundaryRequest,
  trustedPreflightResponse,
  withTrustedOriginCors,
  type NativeSessionBoundaryPolicy,
} from "./session-security.js";
import { SocialEventsRpcHandlers } from "./social-events/rpc.js";
import { TeamApplicationsRpcHandlers } from "./team-application/rpc.js";

/**
 * Renders one problem at the HTTP ingress, outside any RPC: an origin denial, a method outside a
 * path's methods, an unknown path, an unavailable health check, and an RPC body that is too large
 * or not JSON.
 */
const problemWebResponse = (problem: Problem): Response =>
  new Response(JSON.stringify(problemBody(problem)), {
    status: problem.status,
    headers: { ...problemHeaders(problem), "content-type": "application/problem+json" },
  });

/** A browser request from an origin the session boundary does not trust; the answer varies by Origin. */
const originRejected = (): Response => {
  const response = problemWebResponse(Problem.make("origin.denied"));
  response.headers.set("vary", "Origin");

  return response;
};

/** A method outside the path's methods, with the path's Allow header. */
const methodNotAllowed = (methods: ReadonlyArray<string>): Response => {
  const response = problemWebResponse(Problem.make("method.not-allowed"));
  response.headers.set("allow", allowHeader(methods));

  return response;
};

/** The HTTP methods of each native path: the RPC endpoint and the health probe. */
export const nativePreflightMethodsForPath = (pathname: string): ReadonlyArray<string> =>
  isNativeRpcPath(pathname) ? ["POST"] : pathname === "/health" ? ["GET"] : [];

/**
 * The headers a caller may set inside an RPC message. The RPC server lays message headers over
 * the HTTP headers, so any other message header could forge an ingress fact: the source address,
 * the user agent, or the request correlation of an audit record. A server that calls for a person
 * forwards that person's credential, and the homepage its contact secret and the visitor address,
 * which only the contact RPC reads behind its secret.
 */
const callerMessageHeaders: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  CONTACT_BACKEND_HEADER,
  CONTACT_IP_HEADER,
]);

// A request message: its tag and headers, and every other member unchanged.
const RpcRequestMessage = Schema.StructWithRest(
  Schema.TaggedStruct("Request", {
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const decodeRpcRequestMessage = Schema.decodeUnknownOption(RpcRequestMessage);

/**
 * Keeps only the caller message headers of every RPC request message, so the handlers see every
 * other header from the HTTP request alone. A value that is not a request message passes
 * unchanged: the RPC server rejects it.
 */
const restrictRpcMessageHeaders = (body: Schema.Json): Schema.Json => {
  const restrict = (message: Schema.Json): Schema.Json =>
    Option.match(decodeRpcRequestMessage(message), {
      onNone: () => message,
      onSome: (request) => ({
        ...request,
        headers: request.headers.filter(([name]) => callerMessageHeaders.has(name.toLowerCase())),
      }),
    });

  return Array.isArray(body) ? body.map(restrict) : restrict(body);
};

/**
 * The largest RPC request body the ingress reads: a receipt file at its size bound, as the base64
 * text that JSON serialization carries, plus 1 MiB for the rest of the message.
 */
export const nativeRpcMaxBodyBytes = Math.ceil((RECEIPT_FILE_MAX_BYTES * 4) / 3) + 1024 * 1024;

/**
 * The RPC request, read within `nativeRpcMaxBodyBytes`, parsed without duplicate members, and with
 * its message headers restricted; any other request unchanged. A body over the bound is
 * request.too-large and one that is not JSON, or repeats a member, request.malformed: two parsers
 * could disagree on which of two members wins, so the ingress admits neither reading.
 */
const restrictedNativeRequest = (request: Request, pathname: string) =>
  request.method !== "POST" || !(isNativeRpcPath(pathname) || isInternalNativeRpcPath(pathname))
    ? Effect.succeed(request)
    : readBoundedJson(request, nativeRpcMaxBodyBytes).pipe(
        Effect.map((body) => {
          const headers = new Headers(request.headers);

          headers.delete("content-length");

          return new Request(request.url, {
            method: request.method,
            headers,
            body: JSON.stringify(restrictRpcMessageHeaders(body)),
          });
        }),
      );

/**
 * Serves one native request: the RPC endpoint, the health probe, or a not-found answer. No answer
 * is stored by a cache, because an RPC answer is private to its caller, and an ingress problem is
 * rendered before any handler runs.
 */
const serveNative = (nativeHandler: BackendHttpHandler, request: Request, pathname: string) =>
  restrictedNativeRequest(request, pathname).pipe(
    Effect.flatMap(nativeHandler),
    Effect.catch((problem) => Effect.succeed(problemWebResponse(problem))),
    Effect.map((response) => {
      const headers = new Headers(response.headers);

      headers.set("cache-control", "private, no-store");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );

/**
 * Answers one web request. A failure is either rendered as a response or dies, and the server
 * answers a defect as it answers a rejected handler.
 */
export type BackendHttpHandler = (request: Request) => Effect.Effect<Response>;

const jsonResponse = (body: Schema.Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/**
 * The identity engine operations of the HTTP boundary: the Better Auth handler mounted only at
 * `/api/auth/*`, the trusted-origin rejection audit, and the optional OAuth surfaces. They share
 * the process-owned identity engine with the native RPC endpoint.
 */
export type BackendAuthHandler = Pick<
  AuthEngineService,
  "handler" | "recordTrustedOriginRejection"
> &
  Partial<
    Pick<AuthEngineService, "oauthHandler" | "oauthIntrospectionHandler" | "exactRedirectAccepted">
  >;

export type BackendHttpOptions = Omit<NativeRpcOptions, "config">;

/** `GET /health`: the database answers, or health.unavailable. Infrastructure probes it. */
const healthRoute = HttpRouter.use((router) =>
  router.add(
    "GET",
    "/health",
    databaseHealth.pipe(
      // A web Response's body is read once, so each probe gets its own answer.
      Effect.map(() => HttpServerResponse.fromWeb(jsonResponse({ status: "ok" }))),
      Effect.orElseSucceed(() =>
        HttpServerResponse.fromWeb(problemWebResponse(Problem.make("health.unavailable"))),
      ),
    ),
  ),
);

const notFound = HttpRouter.use((router) =>
  router.add(
    "*",
    "*",
    Effect.sync(() =>
      HttpServerResponse.fromWeb(problemWebResponse(Problem.make("resource.not-found"))),
    ),
  ),
);

/**
 * The external native routes: every native RPC at `nativeRpcPath`, and the health probe. The
 * handlers of each context take the same options; the composition root builds them once.
 */
export const ExternalNativeRpcRouterLive = (rpcOptions: NativeRpcOptions) => {
  const config = rpcOptions.config;

  const handlers = Layer.mergeAll(
    AdmissionOutcomesRpcHandlers(rpcOptions),
    AdmissionsRpcHandlers(rpcOptions),
    CertificatesRpcHandlers(rpcOptions),
    ContactRpcHandlers(rpcOptions),
    ContentRpcHandlers(rpcOptions),
    DirectoryRpcHandlers(rpcOptions),
    OnboardingRpcHandlers(rpcOptions),
    OrganizationRpcHandlers(rpcOptions),
    PlacementsRpcHandlers(rpcOptions),
    ProfileRpcHandlers(rpcOptions),
    ReceiptsRpcHandlers(rpcOptions),
    RecruitmentRpcHandlers(rpcOptions),
    SocialEventsRpcHandlers(rpcOptions),
    SystemRpcHandlers(rpcOptions),
    TeamApplicationsRpcHandlers(rpcOptions),
  );

  const rpcRoute = RpcServer.layerHttp({
    group: NativeRpcs,
    path: nativeRpcPath,
    protocol: "http",
  }).pipe(
    Layer.provide(handlers),
    Layer.provide(nativeRpcCredentialLayer(config.contact)),
    Layer.provide(ProblemBoundaryLive),
    Layer.provide(RpcSerialization.layerJson),
  );

  return Layer.mergeAll(rpcRoute, healthRoute, notFound);
};

/** The isolated internal RPC routes for an explicitly selected ingress. */
export const InternalNativeRpcRouterLive = (rpcOptions: NativeRpcOptions) => {
  const config = rpcOptions.config;

  const rpcRoute = RpcServer.layerHttp({
    group: InternalNativeRpcs,
    path: internalNativeRpcPath,
    protocol: "http",
  }).pipe(
    Layer.provide(InternalReceiptsRpcHandlers(rpcOptions)),
    Layer.provide(nativeRpcCredentialLayer(config.contact)),
    Layer.provide(ProblemBoundaryLive),
    Layer.provide(RpcSerialization.layerJson),
  );

  return Layer.mergeAll(rpcRoute, notFound);
};

const oauthAuthorizationServerMetadataPath = "/.well-known/oauth-authorization-server/api/auth";

const externalOAuthRoutes = new Set([
  `GET ${oauthAuthorizationServerMetadataPath}`,
  "GET /api/auth/jwks",
  "GET /api/auth/oauth2/authorize",
  "GET /api/auth/oauth2/public-client",
  "POST /api/auth/oauth2/consent",
  "POST /api/auth/oauth2/token",
  "POST /api/auth/oauth2/revoke",
  "GET /api/auth/oauth2/get-consents",
  "POST /api/auth/oauth2/delete-consent",
]);

const isOAuthProviderNamespace = (pathname: string): boolean =>
  pathname === oauthAuthorizationServerMetadataPath ||
  pathname === "/api/auth/jwks" ||
  pathname.startsWith("/api/auth/oauth2/") ||
  pathname.startsWith("/api/auth/admin/oauth2/") ||
  pathname.startsWith("/admin/oauth2/") ||
  pathname === "/api/auth/userinfo" ||
  pathname.includes("openid-configuration");

const invalidAuthorizationRequest = (): Response => jsonResponse({ error: "invalid_request" }, 400);

const authorizationRequestAccepted = (
  request: Request,
  authHandler: BackendAuthHandler,
): Effect.Effect<boolean, IdentityEngineError> => {
  const url = new URL(request.url);

  if (url.search.length > 8 * 1024) return Effect.succeed(false);

  const required = [
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
    "resource",
    "response_type",
    "scope",
  ] as const;

  if (required.some((name) => url.searchParams.getAll(name).length !== 1)) {
    return Effect.succeed(false);
  }

  const clientId = url.searchParams.get("client_id")!;
  const redirectUri = url.searchParams.get("redirect_uri")!;
  const state = url.searchParams.get("state")!;
  const challenge = url.searchParams.get("code_challenge")!;

  if (
    clientId.length === 0 ||
    !/^[A-Za-z0-9_-]{43,512}$/u.test(state) ||
    url.searchParams.get("response_type") !== "code" ||
    (url.searchParams.get("scope") !== "native-api" &&
      url.searchParams.get("scope") !== "native-api offline_access") ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(challenge) ||
    url.searchParams.get("resource") !== "urn:vektorprogrammet:native-api" ||
    authHandler.exactRedirectAccepted === undefined
  ) {
    return Effect.succeed(false);
  }

  return authHandler.exactRedirectAccepted(clientId, redirectUri);
};

const sourceNetworkList = (networks: ReadonlyArray<string>): BlockList => {
  const list = new BlockList();

  for (const network of networks) {
    const separator = network.lastIndexOf("/");
    const address = network.slice(0, separator);
    const prefix = Number(network.slice(separator + 1));
    const family = isIP(address);

    if (
      separator <= 0 ||
      (family !== 4 && family !== 6) ||
      !Number.isSafeInteger(prefix) ||
      prefix < 0 ||
      prefix > (family === 4 ? 32 : 128)
    ) {
      throw new TypeError("internal OAuth source network must be canonical CIDR");
    }

    list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }

  return list;
};

/**
 * Web handler over the built native router. `HttpEffect.toWebHandler` renders
 * every failure cause as a response, so its promise never rejects.
 */
export const nativeRouterWebHandler = (router: HttpRouter.HttpRouter): BackendHttpHandler => {
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- EX-0001: effect types HttpRouter.asHttpEffect's failure as unknown; routes decide their own failures.
  const handler = HttpEffect.toWebHandler(router.asHttpEffect());

  return (request) => Effect.promise(() => handler(request));
};

/**
 * Explicit external boundary around the native RPC handler. Better Auth and the OAuth routes are
 * the only external path families outside `NativeRpcs` and the health probe.
 */
export const backendHttpHandler: {
  (
    authHandler: BackendAuthHandler,
    sessionBoundary: NativeSessionBoundaryPolicy,
  ): (nativeHandler: BackendHttpHandler) => BackendHttpHandler;
  (
    nativeHandler: BackendHttpHandler,
    authHandler: BackendAuthHandler,
    sessionBoundary: NativeSessionBoundaryPolicy,
  ): BackendHttpHandler;
} = dual(
  3,
  (
    nativeHandler: BackendHttpHandler,
    authHandler: BackendAuthHandler,
    sessionBoundary: NativeSessionBoundaryPolicy,
  ): BackendHttpHandler =>
    (request) =>
      Effect.gen(function* () {
        const prepared = prepareIdentityBoundaryRequest(request);
        const pathname = new URL(prepared.request.url).pathname;
        const oauthNamespace = isOAuthProviderNamespace(pathname);

        if (oauthNamespace && prepared.request.method === "OPTIONS") {
          return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
        }

        const oauthRouteKey = `${prepared.request.method} ${pathname}`;

        if (oauthNamespace && !externalOAuthRoutes.has(oauthRouteKey)) {
          return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
        }

        if (oauthNamespace) {
          if (
            pathname === "/api/auth/oauth2/authorize" &&
            !(yield* authorizationRequestAccepted(prepared.request, authHandler))
          ) {
            return invalidAuthorizationRequest();
          }

          if (authHandler.oauthHandler === undefined) {
            return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
          }

          return yield* authHandler.oauthHandler(prepared.request, prepared.context);
        }

        const credentialFlow =
          (prepared.request.method === "POST" &&
            (pathname === "/api/auth/request-password-reset" ||
              pathname === "/api/auth/reset-password")) ||
          (prepared.request.method === "GET" &&
            /^\/api\/auth\/reset-password\/[^/]+$/.test(pathname))
            ? ("PasswordRecovery" as const)
            : undefined;

        const decision = decideTrustedOrigin(sessionBoundary, prepared.request);
        const acceptedOrigin = Predicate.isTagged(decision, "Allowed") ? decision.origin : null;

        if (Predicate.isTagged(decision, "Rejected")) {
          // The audit is best effort: whatever its outcome, the origin is rejected.
          yield* Effect.ignoreCause(
            authHandler.recordTrustedOriginRejection(prepared.context, credentialFlow),
          );

          return originRejected();
        }

        if (prepared.request.method === "OPTIONS") {
          if (acceptedOrigin === null) {
            yield* Effect.ignoreCause(
              authHandler.recordTrustedOriginRejection(prepared.context, credentialFlow),
            );

            return originRejected();
          }

          const requestedMethod = prepared.request.headers.get("access-control-request-method");

          const preflight = decideNativePreflight({
            pathname,
            requestedMethod,
            headersAllowed: allowsNativePreflightHeaders(prepared.request),
            methodsForPath: nativePreflightMethodsForPath,
          });

          if (Predicate.isTagged(preflight, "HeaderMalformed")) {
            return withTrustedOriginCors(
              problemWebResponse(Problem.make("header.malformed")),
              acceptedOrigin,
            );
          }

          if (Predicate.isTagged(preflight, "MethodNotAllowed")) {
            return withTrustedOriginCors(methodNotAllowed(preflight.methods), acceptedOrigin);
          }

          if (Predicate.isTagged(preflight, "Ready")) {
            return trustedPreflightResponse(acceptedOrigin, preflight.methods);
          }

          if (
            Predicate.isTagged(preflight, "RouteNotFound") &&
            (pathname === "/api/auth/" || pathname.startsWith("/api/auth/"))
          ) {
            if (!allowsNativePreflightHeaders(prepared.request)) {
              return withTrustedOriginCors(
                problemWebResponse(Problem.make("header.malformed")),
                acceptedOrigin,
              );
            }

            const authResponse = yield* authHandler.handler(prepared.request, prepared.context);

            return authResponse.status >= 200 && authResponse.status < 300
              ? trustedPreflightResponse(acceptedOrigin, [preflight.requestedMethod])
              : withTrustedOriginCors(authResponse, acceptedOrigin);
          }

          return withTrustedOriginCors(
            problemWebResponse(Problem.make("resource.not-found")),
            acceptedOrigin,
          );
        }

        const response =
          pathname === "/api/auth/" || pathname.startsWith("/api/auth/")
            ? yield* authHandler.handler(prepared.request, prepared.context)
            : yield* serveNative(nativeHandler, prepared.request, pathname);

        return withTrustedOriginCors(response, acceptedOrigin);
      }).pipe(Effect.orDie),
);

/** Independent internal ingress: native internal API plus one non-fallthrough OAuth route. */
export const internalBackendHttpHandler: {
  (
    authHandler: BackendAuthHandler,
    allowedSourceNetworks: ReadonlyArray<string>,
  ): (nativeHandler: BackendHttpHandler) => BackendHttpHandler;
  (
    nativeHandler: BackendHttpHandler,
    authHandler: BackendAuthHandler,
    allowedSourceNetworks: ReadonlyArray<string>,
  ): BackendHttpHandler;
} = dual(
  3,
  (
    nativeHandler: BackendHttpHandler,
    authHandler: BackendAuthHandler,
    allowedSourceNetworks: ReadonlyArray<string>,
  ): BackendHttpHandler => {
    const allowedSources = sourceNetworkList(allowedSourceNetworks);

    return (request) =>
      Effect.gen(function* () {
        const prepared = prepareIdentityBoundaryRequest(request);
        const pathname = new URL(prepared.request.url).pathname;

        if (isOAuthProviderNamespace(pathname)) {
          if (prepared.request.method !== "POST" || pathname !== "/api/auth/oauth2/introspect") {
            return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
          }

          const sourceIp = prepared.context.sourceIp;
          const family = sourceIp === null ? 0 : isIP(sourceIp);

          if (
            sourceIp === null ||
            (family !== 4 && family !== 6) ||
            !allowedSources.check(sourceIp, family === 4 ? "ipv4" : "ipv6") ||
            authHandler.oauthIntrospectionHandler === undefined
          ) {
            return Response.json(
              { active: false },
              { status: 200, headers: { "cache-control": "no-store", pragma: "no-cache" } },
            );
          }

          return yield* authHandler.oauthIntrospectionHandler(prepared.request, prepared.context);
        }

        return yield* serveNative(nativeHandler, prepared.request, pathname);
      }).pipe(Effect.orDie);
  },
);
