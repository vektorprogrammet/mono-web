import { Admissions } from "@vektorprogrammet/domain/admissions";
import { databaseHealth, type Database } from "@vektorprogrammet/domain/database";
import type { Organization } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { Recruitment } from "@vektorprogrammet/domain/recruitment";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { Effect } from "effect";
import { makeAdmissionApiHttp } from "./admission/http.js";
import type { BackendConfig } from "./config.js";
import { makeOrganizationApiHttp } from "./organization/http.js";
import { makeProfileApiHttp } from "./profile/http.js";
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


const isOrganizationRoute = (pathname: string): boolean =>
  pathname === "/api/departments" ||
  pathname === "/api/teams" ||
  pathname === "/api/field_of_studies" ||
  pathname === "/api/admin/departments" ||
  pathname === "/api/admin/teams" ||
  pathname === "/api/admin/field-of-studies";
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
  const organization = makeOrganizationApiHttp({ config: config.organization, run });
  const profile = makeProfileApiHttp({ config, run });
  return {
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (isOrganizationRoute(pathname)) return organization.fetch(request);
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      if (request.method === "GET" && pathname === "/health") {
        try {
          await run(databaseHealth);
          return jsonResponse({ status: "ok" });
        } catch {
          return jsonResponse({ status: "unavailable" }, 503);
        }
      }
      if (pathname === "/api/me") return profile.fetch(request);
      if (isRecruitmentRoute(pathname)) return recruitment.fetch(request);
      if (isAdmissionRoute(pathname)) return admission.fetch(request);
      if (isReceiptRoute(pathname)) return receipt.fetch(request);
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    },
  };
};
