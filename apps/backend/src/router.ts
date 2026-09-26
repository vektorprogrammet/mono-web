import { OnboardingApiHandlers } from "./onboarding/http.js";
import { PlacementsApiHandlers } from "./placements/http.js";
import { ContactApiHandlers } from "./contact/http.js";
import { BlockList, isIP } from "node:net";
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  AdmissionRoleDenied,
  AdmissionScopeDenied,
  InactiveActor,
  UnauthenticatedActor,
  type AdmissionPeriodActor,
} from "@vektorprogrammet/domain/admission-period";
import {
  RecruitmentInactiveActor,
  RecruitmentRoleDenied,
} from "@vektorprogrammet/domain/recruitment";
import {
  type Identity,
  type IdentityEngineError,
  type IdentityRequestContext,
} from "@vektorprogrammet/domain/identity";
import { DepartmentId, type Organization } from "@vektorprogrammet/domain";
import { ARTICLE_SLUG_MAX_LENGTH } from "@vektorprogrammet/domain/content";
import { ExternalNativeApi, InternalNativeApi } from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Schema, Cause, Predicate, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AdmissionsApiHandlers } from "./admission/http.js";
import { AdmissionOutcomesApiHandlers } from "./admission/outcome-http.js";
import { DirectoryApiHandlers } from "./directory/http.js";
import {
  admissionActorForDepartment,
  unscopedAdmissionActorFrom,
  organizationActorFrom,
  recruitmentBoardActorFrom,
  resolveAuthenticatedPerson,
  resolveAuthenticatedPersonAtInstant,
  resolveRequestPerson,
  resolveRequestPersonAtInstant,
  resolveRequestCredentialAtInstant,
  resolveRequestPersonAuthority,
  type OrganizationResolutionError,
} from "./authority.js";
import type { BackendConfig } from "./config.js";
import { ContentApiHandlers } from "./content/http.js";
import { SystemApiHandlers } from "./http-api/system.js";
import { ProblemBoundaryLive, problemWebResponse } from "./http-api/problem.js";
import { nativeHttpApiMiddlewareLayer } from "./http-api/transport.js";
import { allowHeader } from "./http-semantics.js";
import { externalNativePreflightMethodsForPath } from "./native-api-preflight.js";

import { decideNativePreflight } from "./native-preflight.js";
import { OrganizationApiHandlers } from "./organization/http.js";
import { ProfileApiHandlers } from "./profile/http.js";
import { InternalReceiptApiHandlers, ReceiptApiHandlers } from "./receipt/http.js";
import type { ReceiptIdentityResolvers } from "./receipt/http-context.js";
import {
  ReceiptFileStoreResource,
  ReceiptFileStoreLive,
  type ReceiptFileStore,
} from "./receipt/filesystem.js";
import { RecruitmentApiHandlers } from "./recruitment/http.js";
import { SocialEventsApiHandlers, type SocialEventTransactionHook } from "./social-events/http.js";
import { TeamApplicationsApiHandlers } from "./team-application/http.js";
import {
  allowsNativePreflightHeaders,
  decideTrustedOrigin,
  prepareIdentityBoundaryRequest,
  trustedPreflightResponse,
  withTrustedOriginCors,
  type NativeSessionBoundaryPolicy,
} from "./session-security.js";

/** A browser request from an origin the session boundary does not trust; the answer varies by Origin. */
const originRejected = (): Response => {
  const response = problemWebResponse(Problem.make("origin.denied"));
  response.headers.set("vary", "Origin");

  return response;
};

/** A method outside the resource's frozen method set, with the path's Allow header. */
const methodNotAllowed = (methods: ReadonlyArray<string>): Response => {
  const response = problemWebResponse(Problem.make("method.not-allowed"));
  response.headers.set("allow", allowHeader(methods));

  return response;
};

export const nativeHttpRouterConfig = {
  // FindMyWay compares the encoded path segment. The longest routed identifier is an article
  // slug; the other identifiers are shorter.
  maxParamLength: ARTICLE_SLUG_MAX_LENGTH,
} as const;

export interface BackendHttp {
  readonly fetch: (request: Request) => Promise<Response>;
}

const jsonResponse = (body: Schema.Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

/**
 * The Better Auth Request -> Response handler mounted only at `/api/auth/*`.
 * It shares the process-owned identity engine with the native API.
 */
export interface BackendAuthHandler {
  readonly handle: (request: Request, context: IdentityRequestContext) => Promise<Response>;
  readonly handleOAuth?: (request: Request, context: IdentityRequestContext) => Promise<Response>;
  readonly handleOAuthIntrospection?: (
    request: Request,
    context: IdentityRequestContext,
  ) => Promise<Response>;
  readonly exactRedirectAccepted?: (clientId: string, redirectUri: string) => Promise<boolean>;
  readonly recordTrustedOriginRejection: (
    context: IdentityRequestContext,
    credentialFlow?: "PasswordRecovery",
  ) => Promise<void>;
}

export interface BackendHttpOptions {
  /** Evidence compositions can pin one authorization instant without patching the global clock. */
  readonly now?: () => string;
  /** Test-only social-event transaction coordination for real concurrent snapshot evidence. */
  readonly socialEventsTransactionHook?: SocialEventTransactionHook;
  /** Selects the composition-owned private receipt store; Bun keeps its filesystem default. */
  readonly receiptFileStore?: ReceiptFileStore;
}

/**
 * Builds every external native handler group from the process-owned capability
 * graph. This function constructs Layers once at the composition root.
 */
export const ExternalNativeApiRouterLive = (
  config: BackendConfig,
  options: BackendHttpOptions = {},
) => {
  const resolveAdmissionActor = (
    request: Request,
    departmentScope?: string,
  ): Effect.Effect<
    AdmissionPeriodActor,
    | IdentityEngineError
    | UnauthenticatedActor
    | InactiveActor
    | AdmissionScopeDenied
    | AdmissionRoleDenied
    | OrganizationResolutionError,
    Organization | Identity | OAuthCredentialAuthority
  > =>
    Effect.gen(function* () {
      const authority = yield* resolveRequestPersonAuthority(request, { now: options.now });

      return yield* Effect.try({
        try: () =>
          departmentScope === undefined
            ? unscopedAdmissionActorFrom(authority)
            : admissionActorForDepartment(authority, DepartmentId.make(departmentScope)),
        catch: (cause) => {
          if (
            cause instanceof InactiveActor ||
            cause instanceof AdmissionScopeDenied ||
            cause instanceof AdmissionRoleDenied
          )
            return cause;
          throw cause;
        },
      });
    });

  const receiptIdentity: ReceiptIdentityResolvers<
    IdentityEngineError | UnauthenticatedActor,
    Identity | OAuthCredentialAuthority
  > = {
    resolveAuthorizationPrincipal: (request: Request) =>
      resolveRequestPersonAtInstant(request, { now: options.now }),
    resolvePersonId: (request: Request) => resolveRequestPerson(request),
    resolveApprovalCredential: (request: Request) =>
      resolveRequestCredentialAtInstant(request, "Either", { now: options.now }),
  };

  const receiptOptions = {
    config: config.receipt,
    identity: receiptIdentity,
    now: options.now,
  };

  const middlewareLayer = nativeHttpApiMiddlewareLayer(config.contact);

  const handlers = Layer.mergeAll(
    AdmissionOutcomesApiHandlers({ now: options.now }),
    PlacementsApiHandlers({ now: options.now }),
    OnboardingApiHandlers({ now: options.now, delivery: config.onboarding }),
    ContactApiHandlers(config.contact),
    SystemApiHandlers(options),
    AdmissionsApiHandlers({
      config: config.admission,
      resolveActor: resolveAdmissionActor,
    }),
    ReceiptApiHandlers(receiptOptions).pipe(
      Layer.provide(
        options.receiptFileStore === undefined
          ? ReceiptFileStoreLive({
              stagingRoot: config.receipt.stagingRoot,
              committedRoot: config.receipt.committedRoot,
              failNextPromotionEffectId: config.receipt.e2e?.failNextPromotionEffectId,
            })
          : Layer.succeed(ReceiptFileStoreResource, options.receiptFileStore),
      ),
    ),
    RecruitmentApiHandlers({
      config: config.recruitment,
      resolveActor: (request) =>
        resolveRequestPersonAuthority(request, { now: options.now }).pipe(
          Effect.flatMap((authority) =>
            Effect.try({
              try: () => recruitmentBoardActorFrom(authority),
              catch: (cause) =>
                cause instanceof InactiveActor ||
                cause instanceof RecruitmentInactiveActor ||
                cause instanceof RecruitmentRoleDenied
                  ? cause
                  : new Cause.UnknownError(cause),
            }),
          ),
        ),
    }),
    OrganizationApiHandlers({
      config: config.organization,
      resolveActor: (request) =>
        resolveRequestPersonAuthority(request, { now: options.now }).pipe(
          Effect.map(organizationActorFrom),
        ),
      resolveAuthority: (request) => resolveRequestPersonAuthority(request, { now: options.now }),
    }),
    DirectoryApiHandlers(
      {
        resolveAuthority: (request) => resolveRequestPersonAuthority(request, { now: options.now }),
      },
      {
        resolveActor: (request) => resolveRequestPersonAtInstant(request, { now: options.now }),
      },
    ),
    ContentApiHandlers((request) => resolveRequestPersonAtInstant(request, { now: options.now })),
    ProfileApiHandlers({
      config,
      resolveActor: (request) => resolveRequestPersonAuthority(request, { now: options.now }),
    }),
    SocialEventsApiHandlers({ transactionHook: options.socialEventsTransactionHook }),
    TeamApplicationsApiHandlers(config.teamApplication),
  ).pipe(Layer.provide(middlewareLayer));

  const nativeRoutes = HttpApiBuilder.layer(ExternalNativeApi).pipe(
    Layer.provide(handlers),
    Layer.provide(middlewareLayer),
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

  return Layer.mergeAll(nativeRoutes, notFound, ProblemBoundaryLive);
};

/** Builds the isolated internal API root for an explicitly selected ingress. */
export const InternalNativeApiRouterLive = (
  config: BackendConfig,
  options: BackendHttpOptions = {},
) => {
  const receiptIdentity: ReceiptIdentityResolvers<
    IdentityEngineError | UnauthenticatedActor,
    Identity
  > = {
    resolveAuthorizationPrincipal: (request: Request) =>
      resolveAuthenticatedPersonAtInstant(request.headers.get("cookie") ?? undefined, {
        now: options.now,
      }),
    resolvePersonId: (request: Request) =>
      resolveAuthenticatedPerson(request.headers.get("cookie") ?? undefined),
  };

  const receiptOptions = {
    config: config.receipt,
    identity: receiptIdentity,
    now: options.now,
  };

  const middlewareLayer = nativeHttpApiMiddlewareLayer(config.contact);
  const handlers = InternalReceiptApiHandlers(receiptOptions).pipe(Layer.provide(middlewareLayer));

  const internalRoutes = HttpApiBuilder.layer(InternalNativeApi).pipe(
    Layer.provide(handlers),
    Layer.provide(middlewareLayer),
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

  return Layer.mergeAll(internalRoutes, notFound, ProblemBoundaryLive);
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

const authorizationRequestAccepted = async (
  request: Request,
  authHandler: BackendAuthHandler,
): Promise<boolean> => {
  const url = new URL(request.url);

  if (url.search.length > 8 * 1024) return false;

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

  if (required.some((name) => url.searchParams.getAll(name).length !== 1)) return false;
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
    return false;
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
 * Explicit external boundary around the native HttpApi handler.
 * Better Auth remains the only external path family outside `ExternalNativeApi`.
 */
export const backendHttpHandler = (
  nativeHandler: (request: Request) => Promise<Response>,
  authHandler: BackendAuthHandler,
  sessionBoundary: NativeSessionBoundaryPolicy,
): BackendHttp => ({
  fetch: async (request) => {
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
        !(await authorizationRequestAccepted(prepared.request, authHandler))
      ) {
        return invalidAuthorizationRequest();
      }

      return (
        authHandler.handleOAuth?.(prepared.request, prepared.context) ??
        jsonResponse({ error: { tag: "RouteNotFound" } }, 404)
      );
    }

    const credentialFlow =
      (prepared.request.method === "POST" &&
        (pathname === "/api/auth/request-password-reset" ||
          pathname === "/api/auth/reset-password")) ||
      (prepared.request.method === "GET" && /^\/api\/auth\/reset-password\/[^/]+$/.test(pathname))
        ? ("PasswordRecovery" as const)
        : undefined;

    const decision = decideTrustedOrigin(sessionBoundary, prepared.request);
    const acceptedOrigin = Predicate.isTagged(decision, "Allowed") ? decision.origin : null;

    if (Predicate.isTagged(decision, "Rejected")) {
      await authHandler
        .recordTrustedOriginRejection(prepared.context, credentialFlow)
        .catch(() => undefined);

      return originRejected();
    }

    if (prepared.request.method === "OPTIONS") {
      if (acceptedOrigin === null) {
        await authHandler
          .recordTrustedOriginRejection(prepared.context, credentialFlow)
          .catch(() => undefined);

        return originRejected();
      }

      const requestedMethod = prepared.request.headers.get("access-control-request-method");

      const preflight = decideNativePreflight({
        pathname,
        requestedMethod,
        headersAllowed: allowsNativePreflightHeaders(prepared.request),
        methodsForPath: externalNativePreflightMethodsForPath,
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

        const authResponse = await authHandler.handle(prepared.request, prepared.context);

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
        ? await authHandler.handle(prepared.request, prepared.context)
        : await nativeHandler(prepared.request);

    return withTrustedOriginCors(response, acceptedOrigin);
  },
});

/** Independent internal ingress: native internal API plus one non-fallthrough OAuth route. */
export const internalBackendHttpHandler = (
  nativeHandler: (request: Request) => Promise<Response>,
  authHandler: BackendAuthHandler,
  allowedSourceNetworks: ReadonlyArray<string>,
): BackendHttp => {
  const allowedSources = sourceNetworkList(allowedSourceNetworks);

  return {
    fetch: async (request) => {
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
          !allowedSources.check(sourceIp, family === 4 ? "ipv4" : "ipv6")
        ) {
          return Response.json(
            { active: false },
            {
              status: 200,
              headers: { "cache-control": "no-store", pragma: "no-cache" },
            },
          );
        }

        return (
          authHandler.handleOAuthIntrospection?.(prepared.request, prepared.context) ??
          Response.json(
            { active: false },
            { status: 200, headers: { "cache-control": "no-store", pragma: "no-cache" } },
          )
        );
      }

      return nativeHandler(prepared.request);
    },
  };
};
