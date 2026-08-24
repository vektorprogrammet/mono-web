import { Admissions } from "@vektorprogrammet/domain/admissions";
import { databaseHealth, type Database } from "@vektorprogrammet/domain/database";
import type { Organization } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { Effect } from "effect";
import { makeAdmissionApiHttp } from "./admission/http.js";
import type { BackendConfig } from "./config.js";
import { makeReceiptApiHttp } from "./receipt/http.js";
import { makeRecruitmentApiHttp } from "./recruitment/http.js";
export type BackendRun = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Database | Admissions | Economy | Organization | Profile | Recruitment
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

const bearerToken = (request: Request): string | undefined => {
  const authorization = request.headers.get("authorization");
  return authorization === null ? undefined : /^Bearer ([^\s]+)$/.exec(authorization)?.[1];
};

const profileResponse = async (
  request: Request,
  config: BackendConfig,
  run: BackendRun,
): Promise<Response> => {
  const token = bearerToken(request);
  const admissionPrincipal = token === undefined ? undefined : config.admission.tokens.get(token);
  const receiptPrincipal = token === undefined ? undefined : config.receipt.tokens.get(token);
  const recruitmentPrincipal =
    token === undefined ? undefined : config.recruitment.tokens.get(token);
  const actor = admissionPrincipal?.actor ?? receiptPrincipal?.actor ?? recruitmentPrincipal?.actor;
  if (actor === undefined) return jsonResponse({ error: { tag: "UnauthenticatedActor" } }, 401);
  if (!actor.active) return jsonResponse({ error: { tag: "InactiveActor" } }, 403);

  const role =
    "_tag" in actor
      ? actor._tag === "DepartmentLeader"
        ? "ROLE_TEAM_LEADER"
        : actor._tag === "GlobalAdmin"
          ? "ROLE_ADMIN"
          : "ROLE_TEAM_MEMBER"
      : actor.approvalScope._tag === "Global"
        ? "ROLE_ADMIN"
        : actor.approvalScope._tag === "Department"
          ? "ROLE_TEAM_LEADER"
          : "ROLE_TEAM_MEMBER";
  try {
    const [profile] = await run(Profile.use(({ readProfiles }) => readProfiles([actor.personId])));
    if (profile === undefined) {
      return jsonResponse({ error: { tag: "ProfileNotFound" } }, 404);
    }
    return jsonResponse({
      id: null,
      firstName: profile.firstName,
      lastName: profile.lastName,
      userName: null,
      email: "",
      phone: null,
      gender: null,
      fieldOfStudy: null,
      accountNumber: null,
      role,
      profilePhoto: null,
    });
  } catch {
    return jsonResponse({ error: { tag: "ProfileUnavailable" } }, 503);
  }
};

const isAdmissionRoute = (pathname: string): boolean =>
  pathname === "/api/admission-periods/open" ||
  pathname.startsWith("/api/admin/admission-periods") ||
  pathname === "/api/applications" ||
  pathname.startsWith("/api/applications/");
const isReceiptRoute = (pathname: string): boolean =>
  pathname === "/api/receipts" ||
  pathname.startsWith("/api/receipts/") ||
  pathname === "/api/admin/receipts" ||
  pathname.startsWith("/api/admin/receipts/") ||
  pathname.startsWith("/api/e2e/receipts/");

const isRecruitmentRoute = (pathname: string): boolean =>
  pathname === "/api/admin/recruitment/assignment-board" ||
  pathname === "/api/admin/recruitment/interviews/assign" ||
  pathname === "/api/admin/recruitment/interviews/scheduling-board" ||
  pathname === "/api/recruitment/invitation-response" ||
  pathname === "/api/recruitment/invitation-response/confirm" ||
  pathname === "/api/recruitment/invitation-response/reject" ||
  pathname === "/api/recruitment/invitation-response/request-new-time" ||
  pathname === "/api/admin/recruitment/interviews/schedule";

export const makeBackendHttp = (config: BackendConfig, run: BackendRun): BackendHttp => {
  const admission = makeAdmissionApiHttp({ config: config.admission, run });
  const receipt = makeReceiptApiHttp({ config: config.receipt, run });
  const recruitment = makeRecruitmentApiHttp({ config: config.recruitment, run });
  return {
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      if (request.method === "GET" && pathname === "/health") {
        try {
          await run(databaseHealth);
          return jsonResponse({ status: "ok" });
        } catch {
          return jsonResponse({ status: "unavailable" }, 503);
        }
      }
      if (request.method === "GET" && (pathname === "/api/me" || pathname === "/api/me/profile")) {
        return profileResponse(request, config, run);
      }
      if (isRecruitmentRoute(pathname)) return recruitment.fetch(request);
      if (isAdmissionRoute(pathname)) return admission.fetch(request);
      if (isReceiptRoute(pathname)) return receipt.fetch(request);
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    },
  };
};
