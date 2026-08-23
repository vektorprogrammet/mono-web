import { Admissions } from "@vektorprogrammet/domain/admissions";
import { databaseHealth, type Database } from "@vektorprogrammet/domain/database";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { Effect } from "effect";
import { makeAdmissionApiHttp } from "./admission/http.js";
import type { BackendConfig } from "./config.js";
import { makeReceiptApiHttp } from "./receipt/http.js";

export type BackendRun = <A, E>(
  effect: Effect.Effect<A, E, Database | Admissions | Economy>,
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

const profileResponse = (request: Request, config: BackendConfig): Response => {
  const token = bearerToken(request);
  const admissionPrincipal = token === undefined ? undefined : config.admission.tokens.get(token);
  const receiptPrincipal = token === undefined ? undefined : config.receipt.tokens.get(token);
  const actor = admissionPrincipal?.actor ?? receiptPrincipal?.actor;
  if (actor === undefined) return jsonResponse({ error: { tag: "UnauthenticatedActor" } }, 401);
  if (!actor.active) return jsonResponse({ error: { tag: "InactiveActor" } }, 403);
  return jsonResponse({
    id: null,
    firstName: actor.personId,
    lastName: "",
    userName: actor.personId,
    email: `${actor.personId}@local.invalid`,
    phone: null,
    gender: null,
    fieldOfStudy: null,
    accountNumber: null,
    role: "assistant",
    profilePhoto: null,
  });
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

export const makeBackendHttp = (config: BackendConfig, run: BackendRun): BackendHttp => {
  const admission = makeAdmissionApiHttp({ config: config.admission, run });
  const receipt = makeReceiptApiHttp({ config: config.receipt, run });
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
        return profileResponse(request, config);
      }
      if (isAdmissionRoute(pathname)) return admission.fetch(request);
      if (isReceiptRoute(pathname)) return receipt.fetch(request);
      return jsonResponse({ error: { tag: "RouteNotFound" } }, 404);
    },
  };
};
