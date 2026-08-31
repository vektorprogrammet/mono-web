import { Admissions } from "@vektorprogrammet/domain/admissions";
import type { AdmissionPeriodActor } from "@vektorprogrammet/domain/admission-period";
import { InactiveActor, UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { Content, ContentManagement } from "@vektorprogrammet/domain/content";
import { type Database } from "@vektorprogrammet/domain/database";
import { Identity } from "@vektorprogrammet/domain/identity";
import { DepartmentId, type Organization } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { Economy } from "@vektorprogrammet/domain/receipt";
import type { Schools } from "@vektorprogrammet/domain/schools";
import { NativeApi, OrganizationApi, RecruitmentApi } from "@vektorprogrammet/http-api";
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
  readonly handle: (request: Request) => Promise<Response>;
}

export interface BackendHttpOptions {
  /** Evidence compositions can pin one authorization instant without patching the global clock. */
  readonly now?: () => string;
}

/**
 * Builds every native handler group from the process-owned capability graph.
 * This function constructs Layers once at the composition root, never per route.
 */
export const makeNativeApiRouterLayer = (
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
  };

  const handlers = Layer.mergeAll(
    SystemApiHandlers(run, options),
    AdmissionsApiHandlers({
      config: config.admission,
      resolveActor: resolveAdmissionActor,
      run,
    }),
    ReceiptApiHandlers(receiptOptions),
    InternalReceiptApiHandlers(receiptOptions),
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

  const nativeRoutes = HttpApiBuilder.layer(NativeApi).pipe(
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

const organizationPaths = new Set<string>(
  Object.values(OrganizationApi.endpoints).map((endpoint) => endpoint.path),
);

const malformedRecruitmentPath = (method: string, pathname: string): boolean =>
  [
    RecruitmentApi.endpoints.readInterviewConduct,
    RecruitmentApi.endpoints.finalizeInterview,
    RecruitmentApi.endpoints.cancelInterview,
  ].some(
    (endpoint) =>
      method === endpoint.method && pathname === endpoint.path.replace(":interviewId", ""),
  );

const organizationPreflight = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
      "cache-control": "no-store",
    },
  });

/**
 * Explicit external boundary around the native HttpApi handler.
 * Better Auth remains the only path family outside `NativeApi`.
 */
export const makeBackendHttp = (
  nativeHandler: (request: Request) => Promise<Response>,
  authHandler: BackendAuthHandler,
): BackendHttp => ({
  fetch: (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/auth/" || pathname.startsWith("/api/auth/")) {
      return authHandler.handle(request);
    }
    if (request.method === "OPTIONS") {
      return Promise.resolve(
        organizationPaths.has(pathname)
          ? organizationPreflight()
          : new Response(null, { status: 204 }),
      );
    }
    if (malformedRecruitmentPath(request.method, pathname)) {
      return Promise.resolve(jsonResponse({ error: { tag: "RecruitmentDecodeError" } }, 422));
    }
    return nativeHandler(request);
  },
});
