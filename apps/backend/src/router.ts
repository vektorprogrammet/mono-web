import { IdentitySnapshot } from "@vektorprogrammet/database";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import type { AdmissionPeriodActor } from "@vektorprogrammet/domain/admission-period";
import { InactiveActor, UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { Content, ContentManagement } from "@vektorprogrammet/domain/content";
import { type Database } from "@vektorprogrammet/domain/database";
import { Identity, type IdentityRequestContext } from "@vektorprogrammet/domain/identity";
import { DepartmentId, type Organization } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { Economy } from "@vektorprogrammet/domain/receipt";
import type { Schools } from "@vektorprogrammet/domain/schools";
import { ExternalNativeApi, InternalNativeApi, RecruitmentApi } from "@vektorprogrammet/http-api";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AdminUsersApiHandlers } from "./admin-users/http.js";
import { AdmissionsApiHandlers } from "./admission/http.js";
import {
  admissionActorForDepartment,
  organizationActorFrom,
  profileRoleFrom,
  recruitmentBoardActorFrom,
  resolveAuthenticatedPerson,
  resolveAuthenticatedPersonAtInstant,
  resolvePersonAuthority,
  resolvePersonAuthorityAfterSession,
} from "./authority.js";
import type { BackendConfig } from "./config.js";
import { ContentApiHandlers } from "./content/http.js";
import { SystemApiHandlers } from "./http-api/system.js";
import { NativeHttpApiMiddlewareLive } from "./http-api/transport.js";
import { OrganizationApiHandlers } from "./organization/http.js";
import { ProfileApiHandlers } from "./profile/http.js";
import {
  InternalReceiptApiHandlers,
  ReceiptApiHandlers,
  type ReceiptIdentityResolvers,
} from "./receipt/http.js";
import { RecruitmentApiHandlers } from "./recruitment/http.js";
import {
  allowsNativePreflightHeaders,
  decideTrustedOrigin,
  prepareIdentityBoundaryRequest,
  trustedOriginRejectedResponse,
  trustedPreflightResponse,
  withTrustedOriginCors,
  type NativeSessionBoundaryPolicy,
} from "./session-security.js";

export type BackendRun = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Database
    | Admissions
    | Economy
    | Organization
    | Profile
    | Recruitment
    | Schools
    | Identity
    | IdentitySnapshot
    | ContentManagement
    | Content
  >,
) => Promise<A>;

export interface BackendHttp {
  readonly fetch: (request: Request) => Promise<Response>;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const profileAuthorityError = (
  tag: "AuthorityInactive" | "NotInScope",
): Error & { readonly _tag: typeof tag } => {
  const error = new Error(tag) as Error & { readonly _tag: typeof tag };
  Object.defineProperty(error, "_tag", { value: tag, enumerable: true });
  return error;
};

/**
 * The Better Auth Request -> Response handler mounted only at `/api/auth/*`.
 * It shares the process-owned identity engine with the native API.
 */
export interface BackendAuthHandler {
  readonly handle: (request: Request, context: IdentityRequestContext) => Promise<Response>;
  readonly recordTrustedOriginRejection: (context: IdentityRequestContext) => Promise<void>;
}

export interface BackendHttpOptions {
  /** Evidence compositions can pin one authorization instant without patching the global clock. */
  readonly now?: () => string;
}

/**
 * Builds every external native handler group from the process-owned capability
 * graph. This function constructs Layers once at the composition root.
 */
export const makeExternalNativeApiRouterLayer = (
  config: BackendConfig,
  run: BackendRun,
  options: BackendHttpOptions = {},
) => {
  const resolveAdmissionActor = async (
    request: Request,
    departmentScope?: string,
  ): Promise<AdmissionPeriodActor> => {
    const cookie = request.headers.get("cookie") ?? undefined;
    if (departmentScope === undefined) {
      const authority = await resolvePersonAuthority(cookie, { run, now: options.now });
      if (authority.globalAdministrator !== "Active") {
        throw authority.globalAdministrator === "Inactive"
          ? new InactiveActor({ personId: authority.personId })
          : new UnauthenticatedActor({ message: "no authority for unscoped management route" });
      }
      return {
        _tag: "GlobalAdmin",
        personId: authority.personId,
        active: true,
      };
    }
    const authority = await resolvePersonAuthority(cookie, { run, now: options.now });
    return admissionActorForDepartment(authority, DepartmentId.make(departmentScope));
  };

  const receiptIdentity: ReceiptIdentityResolvers = {
    resolveAuthorizationPrincipal: async (cookieHeader) =>
      resolveAuthenticatedPersonAtInstant(cookieHeader, { run, now: options.now }),
    resolvePersonId: async (cookieHeader) =>
      resolveAuthenticatedPerson(cookieHeader, { run, now: options.now }),
  };
  const receiptOptions = {
    config: config.receipt,
    identity: receiptIdentity,
    run,
    now: options.now,
  };

  const handlers = Layer.mergeAll(
    SystemApiHandlers(run, options),
    AdmissionsApiHandlers({
      config: config.admission,
      resolveActor: resolveAdmissionActor,
      run,
    }),
    ReceiptApiHandlers(receiptOptions),
    RecruitmentApiHandlers({
      config: config.recruitment,
      resolveConductContext: async (request) => {
        const authority = await resolvePersonAuthorityAfterSession(
          request.headers.get("cookie") ?? undefined,
          { run, now: options.now },
        );
        return {
          actor: {
            _tag: "Member",
            personId: authority.personId,
            departmentId: DepartmentId.make(authority.memberships[0]?.departmentId ?? "conduct"),
            active: true,
          },
          authorizationInstant: authority.evaluatedAt,
        };
      },
      resolveActor: async (request) => {
        const authority = await resolvePersonAuthority(request.headers.get("cookie") ?? undefined, {
          run,
          now: options.now,
        });
        return recruitmentBoardActorFrom(authority);
      },
      run,
    }),
    OrganizationApiHandlers({
      config: config.organization,
      resolveActor: async (request) => {
        const authority = await resolvePersonAuthority(request.headers.get("cookie") ?? undefined, {
          run,
          now: options.now,
        });
        return organizationActorFrom(authority);
      },
      resolveAuthority: (request) =>
        resolvePersonAuthority(request.headers.get("cookie") ?? undefined, {
          run,
          now: options.now,
        }),
      run,
    }),
    AdminUsersApiHandlers(
      {
        resolveAuthority: (request) =>
          resolvePersonAuthority(request.headers.get("cookie") ?? undefined, {
            run,
            now: options.now,
          }),
        run,
      },
      {
        resolveActor: (request) =>
          resolveAuthenticatedPersonAtInstant(request.headers.get("cookie") ?? undefined, {
            run,
            now: options.now,
          }),
        run,
      },
    ),
    ContentApiHandlers(
      (request) =>
        resolveAuthenticatedPersonAtInstant(request.headers.get("cookie") ?? undefined, {
          run,
          now: options.now,
        }),
      run,
    ),
    ProfileApiHandlers({
      config,
      resolveActor: async (request) => {
        const authority = await resolvePersonAuthority(request.headers.get("cookie") ?? undefined, {
          run,
          now: options.now,
        });
        const decision = profileRoleFrom(authority);
        if (decision._tag === "Deny") {
          if (decision.reason === "Unauthenticated") {
            throw new UnauthenticatedActor({ message: "profile authority is unauthenticated" });
          }
          throw profileAuthorityError(
            decision.reason === "AuthorityInactive" ? "AuthorityInactive" : "NotInScope",
          );
        }
        return { personId: authority.personId, role: decision.value };
      },
      run,
    }),
  ).pipe(Layer.provide(NativeHttpApiMiddlewareLive));

  const nativeRoutes = HttpApiBuilder.layer(ExternalNativeApi).pipe(
    Layer.provide(handlers),
    Layer.provide(NativeHttpApiMiddlewareLive),
  );
  const notFound = HttpRouter.use((router) =>
    router.add(
      "*",
      "*",
      Effect.sync(() =>
        HttpServerResponse.fromWeb(jsonResponse({ error: { tag: "RouteNotFound" } }, 404)),
      ),
    ),
  );
  return Layer.merge(nativeRoutes, notFound);
};

/** Builds the isolated internal API root for an explicitly selected ingress. */
export const makeInternalNativeApiRouterLayer = (
  config: BackendConfig,
  run: BackendRun,
  options: BackendHttpOptions = {},
) => {
  const receiptOptions = {
    config: config.receipt,
    identity: {
      resolveAuthorizationPrincipal: async (cookieHeader: string | undefined) =>
        resolveAuthenticatedPersonAtInstant(cookieHeader, { run, now: options.now }),
      resolvePersonId: async (cookieHeader: string | undefined) =>
        resolveAuthenticatedPerson(cookieHeader, { run, now: options.now }),
    } satisfies ReceiptIdentityResolvers,
    run,
    now: options.now,
  };
  const handlers = InternalReceiptApiHandlers(receiptOptions).pipe(
    Layer.provide(NativeHttpApiMiddlewareLive),
  );
  const internalRoutes = HttpApiBuilder.layer(InternalNativeApi).pipe(
    Layer.provide(handlers),
    Layer.provide(NativeHttpApiMiddlewareLive),
  );
  const notFound = HttpRouter.use((router) =>
    router.add(
      "*",
      "*",
      Effect.sync(() =>
        HttpServerResponse.fromWeb(jsonResponse({ error: { tag: "RouteNotFound" } }, 404)),
      ),
    ),
  );
  return Layer.merge(internalRoutes, notFound);
};

const malformedRecruitmentPath = (method: string, pathname: string): boolean =>
  [
    RecruitmentApi.endpoints.readInterviewConduct,
    RecruitmentApi.endpoints.finalizeInterview,
    RecruitmentApi.endpoints.cancelInterview,
  ].some(
    (endpoint) =>
      method === endpoint.method && pathname === endpoint.path.replace(":interviewId", ""),
  );

/**
 * Explicit external boundary around the native HttpApi handler.
 * Better Auth remains the only external path family outside `ExternalNativeApi`.
 */
export const makeBackendHttp = (
  nativeHandler: (request: Request) => Promise<Response>,
  authHandler: BackendAuthHandler,
  sessionBoundary: NativeSessionBoundaryPolicy,
): BackendHttp => ({
  fetch: async (request) => {
    const prepared = prepareIdentityBoundaryRequest(request);
    const decision = decideTrustedOrigin(sessionBoundary, prepared.request);
    const preflightHeadersAllowed =
      prepared.request.method !== "OPTIONS" || allowsNativePreflightHeaders(prepared.request);
    if (
      decision._tag === "Rejected" ||
      (prepared.request.method === "OPTIONS" &&
        (decision.origin === null || !preflightHeadersAllowed))
    ) {
      await authHandler.recordTrustedOriginRejection(prepared.context).catch(() => undefined);
      return trustedOriginRejectedResponse();
    }
    if (prepared.request.method === "OPTIONS") {
      return trustedPreflightResponse(decision.origin!);
    }
    const pathname = new URL(prepared.request.url).pathname;
    let response: Response;
    if (pathname === "/api/auth/" || pathname.startsWith("/api/auth/")) {
      response = await authHandler.handle(prepared.request, prepared.context);
    } else if (malformedRecruitmentPath(prepared.request.method, pathname)) {
      response = jsonResponse({ error: { tag: "RecruitmentDecodeError" } }, 422);
    } else {
      response = await nativeHandler(prepared.request);
    }
    return withTrustedOriginCors(response, decision.origin);
  },
});
