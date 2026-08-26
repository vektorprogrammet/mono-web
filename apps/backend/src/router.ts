import { Admissions } from "@vektorprogrammet/domain/admissions";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { InactiveActor, UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import { Auth } from "@vektorprogrammet/domain/auth";
import { databaseHealth, type Database } from "@vektorprogrammet/domain/database";
import type { Organization } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { ContentManagement } from "@vektorprogrammet/domain/content";
import { Content } from "@vektorprogrammet/domain/content";
import { readPublishedArticlePostgres, readNewsListingPostgres } from "@vektorprogrammet/domain/content";
import type { Schools } from "@vektorprogrammet/domain/schools";
import { DateTime, Effect } from "effect";
import type { AdmissionPeriodActor } from "@vektorprogrammet/domain/admission-period";
import { makeAdminUsersApiHttp } from "./admin-users/http.js";
import { makeAdmissionApiHttp } from "./admission/http.js";
import {
  admissionActorForDepartment,
  organizationActorFrom,
  profileRoleFrom,
  recruitmentBoardActorFrom,
  resolveAuthenticatedPerson,
  resolveAuthenticatedPersonAtInstant,
  resolveAuthenticatedSession,
  resolvePersonAuthority,
} from "./authority.js";
import type { BackendConfig } from "./config.js";
import { makeOrganizationApiHttp } from "./organization/http.js";
import { makeProfileApiHttp } from "./profile/http.js";
import { makeReceiptApiHttp, type ReceiptAuthorityResolvers } from "./receipt/http.js";
import { makeRecruitmentApiHttp } from "./recruitment/http.js";
import { makeContentManagementApiHttp, makePublicNewsApiHttp } from "./content/http.js";
import { makeSchoolsApiHttp } from "./schools/http.js";

export type BackendRun = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Database
      | Admissions
      | Economy
      | Organization
      | Profile
      | Recruitment
      | Schools
      | Auth
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

const isAdmissionRoute = (pathname: string): boolean =>
  pathname === "/api/admission-periods/open" ||
  pathname.startsWith("/api/admin/admission-periods") ||
  pathname === "/api/applications" ||
  pathname.startsWith("/api/applications/");
const isContentStaffRoute = (pathname: string): boolean =>
  pathname === "/api/admin/content/workspace" ||
  pathname.startsWith("/api/admin/content/drafts");
const isPublicNewsPath = (pathname: string): boolean =>
  pathname === "/api/news" || pathname.startsWith("/api/news/");
const isReceiptRoute = (pathname: string): boolean =>
  pathname === "/api/receipts" ||
  pathname.startsWith("/api/receipts/") ||
  pathname === "/api/admin/receipts" ||
  pathname.startsWith("/api/admin/receipts/") ||
  pathname.startsWith("/api/e2e/receipts/");

const isOrganizationRoute = (pathname: string): boolean =>
  pathname === "/api/departments" ||
  pathname === "/api/teams" ||
  pathname === "/api/field_of_studies" ||
  pathname === "/api/admin/departments" ||
  pathname === "/api/admin/teams" ||
  pathname === "/api/admin/field-of-studies" ||
  pathname === "/api/admin/team-interest" ||
  pathname === "/api/admin/mailing-lists";
const isRecruitmentRoute = (pathname: string): boolean =>
  pathname === "/api/admin/recruitment/assignment-board" ||
  pathname === "/api/admin/recruitment/interviews/assign" ||
  pathname === "/api/admin/recruitment/interviews/scheduling-board" ||
  pathname === "/api/recruitment/invitation-response" ||
  pathname === "/api/recruitment/invitation-response/confirm" ||
  pathname === "/api/recruitment/invitation-response/reject" ||
  pathname === "/api/recruitment/invitation-response/request-new-time" ||
  pathname === "/api/admin/recruitment/interviews/schedule";

/**
 * The better-auth Request -> Response handler mounted at /api/auth/*.
 * Supplied by the composition root from the ONE Layer-scoped engine so the
 * HTTP surface and the Auth Service share a single session authority.
 */
export interface BackendAuthHandler {
  readonly handle: (request: Request) => Promise<Response>;
}

export const makeBackendHttp = (
  config: BackendConfig,
  run: BackendRun,
  authHandler: BackendAuthHandler,
): BackendHttp => {
  /**
   * Cookie -> Organization projection -> department-scoped admission actor.
   * The department scope comes from canonical request state (payload or the
   * period's immutable department). One authorizationInstant covers session
   * resolution, projection, and mapping.
   */
  const resolveAdmissionActor = async (
    request: Request,
    departmentScope?: string,
  ): Promise<AdmissionPeriodActor> => {
    const cookie = request.headers.get("cookie") ?? undefined;
    if (departmentScope === undefined) {
      // No canonical scope: only an active global administrator is authorized.
      const authority = await resolvePersonAuthority(cookie, { run });
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
    const authority = await resolvePersonAuthority(cookie, { run });
    return admissionActorForDepartment(authority, DepartmentId.make(departmentScope));
  };
  const admission = makeAdmissionApiHttp({
    config: config.admission,
    resolveActor: resolveAdmissionActor,
    run,
  });
  /**
   * Cookie -> PersonId -> ReceiptAuthority (spec 0055): the Organization
   * projection captures ONE authorizationInstant; Economy composes its
   * payment/approval facts with that same-instant projection.
   */
  const resolveReceiptAuthorityFor: ReceiptAuthorityResolvers["resolveAuthority"] = async (
    cookieHeader,
  ) => {
    const authorityProjection = await resolvePersonAuthority(cookieHeader, { run });
    return await run(
      Economy.use(({ resolveReceiptAuthority }) =>
        resolveReceiptAuthority(
          authorityProjection.personId,
          authorityProjection.evaluatedAt,
          authorityProjection,
        ),
      ),
    );
  };
  const receipt = makeReceiptApiHttp({
    config: config.receipt,
    authority: {
      resolveAuthority: resolveReceiptAuthorityFor,
      resolvePersonId: async (cookieHeader) => resolveAuthenticatedPerson(cookieHeader, { run }),
    },
    run,
  });
  const recruitment = makeRecruitmentApiHttp({
    config: config.recruitment,
    // Spec 0055 §Recruitment actor: board queries use ALL authorized
    // departments. One active-leader department selects its scope; ambiguity
    // fails closed. GlobalAdmin never passes (domain rejects it downstream).
    resolveActor: async (request) => {
      const authority = await resolvePersonAuthority(request.headers.get("cookie") ?? undefined, {
        run,
      });
      return recruitmentBoardActorFrom(authority);
    },
    run,
  });
  const organization = makeOrganizationApiHttp({
    config: config.organization,
    resolveActor: async (request) => {
      const cookie = request.headers.get("cookie") ?? undefined;
      const authority = await resolvePersonAuthority(cookie, { run });
      return organizationActorFrom(authority);
    },
    // Specs 0059/0060 leader-scoped reads: one captured authorizationInstant
    // per request covers session resolution, scope computation, and the read.
    resolveAuthority: (request) =>
      resolvePersonAuthority(request.headers.get("cookie") ?? undefined, { run }),
    run,
  });
  const adminUsers = makeAdminUsersApiHttp({
    resolveAuthority: (request) =>
      resolvePersonAuthority(request.headers.get("cookie") ?? undefined, { run }),
    run,
  });
  const schools = makeSchoolsApiHttp({
    resolveActor: (request) =>
      resolveAuthenticatedPersonAtInstant(request.headers.get("cookie") ?? undefined, { run }),
    run,
  });
  /**
   * Spec 0062: staff content routes resolve one PersonId + instant via the
   * session; each journey resolves the Organization projection inside its own
   * transaction. Public news is unauthenticated. Journeys are invoked
   * directly through `run` exactly like the schools adapter — no Promise
   * bridging inside an Effect.
   */
  const content = makeContentManagementApiHttp(
    (request: Request) =>
      resolveAuthenticatedPersonAtInstant(request.headers.get("cookie") ?? undefined, { run }),
    run,
  );
  const publicNews = makePublicNewsApiHttp(
    () => run(readNewsListingPostgres()),
    (slug) => run(readPublishedArticlePostgres(slug)),
  );

  const profile = makeProfileApiHttp({
    config,
    resolveActor: async (request) => {
      const cookie = request.headers.get("cookie") ?? undefined;
      const authority = await resolvePersonAuthority(cookie, { run });
      // Decision-based translation: Deny(NotInScope/AuthorityInactive) becomes
      // the typed profile denial instead of an ambiguous default role.
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
  });

  /** Strict session read: raw Cookie header in, actor projection or typed failure out. */
  const meSession = async (request: Request): Promise<Response> => {
    const cookie = request.headers.get("cookie") ?? undefined;
    const actor = await resolveAuthenticatedSession(cookie, { run });
    return jsonResponse({
      personId: actor.personId,
      expiresAt: DateTime.toDateUtc(actor.expiresAt).toISOString(),
    });
  };

  return {
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/auth/" || pathname.startsWith("/api/auth/")) {
        return authHandler.handle(request);
      }
      if (isOrganizationRoute(pathname)) return organization.fetch(request);
      if (request.method === "GET" && pathname === "/api/admin/users") {
        return adminUsers.fetch(request);
      }
      if (request.method === "GET" && pathname === "/api/admin/schools") {
        return schools.fetch(request);
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      if (request.method === "GET" && pathname === "/health") {
        try {
          await run(databaseHealth);
          return jsonResponse({ status: "ok" });
        } catch {
          return jsonResponse({ status: "unavailable" }, 503);
        }
      }
      if (request.method === "GET" && pathname === "/api/me/session") {
        try {
          return await meSession(request);
        } catch (cause) {
          const unauthenticated = cause instanceof UnauthenticatedActor;
          return jsonResponse(
            {
              error: {
                tag: unauthenticated ? "UnauthenticatedActor" : "AuthEngineError",
              },
            },
            unauthenticated ? 401 : 503,
          );
        }
      }
      if (pathname === "/api/me") return profile.fetch(request);
      if (isRecruitmentRoute(pathname)) return recruitment.fetch(request);
      if (isAdmissionRoute(pathname)) return admission.fetch(request);
      if (isReceiptRoute(pathname)) return receipt.fetch(request);
      if (isContentStaffRoute(pathname)) return content.fetch(request);
      if (isPublicNewsPath(pathname)) return publicNews.fetch(request);
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    },
  };
};
