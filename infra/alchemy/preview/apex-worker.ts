/**
 * Apex edge worker (stage dev-main, hostname vektor.phibkro.org).
 *
 *   /api/*  -> native backend origin (origin-api.vektor.phibkro.org)
 *   Dashboard route families and auth pages -> Dashboard Website.Vite worker
 *   else    -> Homepage Website.Vite worker
 *
 * Additive to p20: shares zero resources with the p20 stack; every physical
 * resource name is prefixed `vektor-apex-`.
 */
import { APEX_IDENTITY } from "./identity.ts";
import { apexSurface } from "./surface-apex.ts";
import { validateDashboardPreviewStage } from "../../../apps/dashboard/workers/preview-stage.ts";

interface ApexService {
  fetch(request: Request): Promise<Response>;
}

export interface ApexWorkerEnv {
  readonly Homepage: ApexService;
  readonly Dashboard: ApexService;
  readonly PREVIEW_STAGE: string;
  readonly PREVIEW_HOST: string;
}

/**
 * Worker subrequests use the dedicated tunnel hostname. The apex Worker does
 * not own that hostname.
 */
export const BACKEND_ORIGIN = APEX_IDENTITY.backendOrigin;

const ALLOWED_HOSTS: Record<string, true> = {
  [APEX_IDENTITY.hostname]: true,
};

/**
 * The backend answers with a Location header relative to its own
 * BETTER_AUTH_URL; rewrite absolute redirects back onto the apex origin.
 */
const proxyResponse = (backendResponse: Response): Response => {
  const headers = new Headers(backendResponse.headers);
  headers.set("x-robots-tag", "noindex");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  const location = headers.get("location");
  if (location !== null && location.startsWith(BACKEND_ORIGIN)) {
    headers.set(
      "location",
      `https://${APEX_IDENTITY.hostname}${location.slice(BACKEND_ORIGIN.length)}`,
    );
  }
  return new Response(backendResponse.body, {
    status: backendResponse.status,
    statusText: backendResponse.statusText,
    headers,
  });
};

const withPreviewStage = (response: Response, stage: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("x-mono-web-stage", stage);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const backendUrl = (url: URL): URL => new URL(`${url.pathname}${url.search}`, BACKEND_ORIGIN);

export default {
  async fetch(request: Request, env: ApexWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    let stage: string;
    try {
      stage = validateDashboardPreviewStage(env.PREVIEW_STAGE, env.PREVIEW_HOST);
    } catch {
      return new Response("Invalid preview stage configuration", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }

    if (!(host in ALLOWED_HOSTS) || host.includes(APEX_IDENTITY.forbiddenHost)) {
      return new Response("Forbidden apex destination", {
        status: 421,
        headers: { "cache-control": "no-store" },
      });
    }

    // GET /api/health is a first-class probe: map it directly to the
    // backend's /health so it never depends on API route matching.
    if (url.pathname === "/api/health" && request.method === "GET") {
      return withPreviewStage(
        proxyResponse(
          await fetch(
            new Request(backendUrl(new URL("/health", url.origin)), {
              method: "GET",
              headers: request.headers,
            }),
          ),
        ),
        stage,
      );
    }

    // Shared brand assets exist identically in both apps' public roots;
    // serve them from the homepage so unprefixed requests resolve.
    if (url.pathname === "/vektor-logo-circle.svg") {
      return withPreviewStage(await env.Homepage.fetch(request), stage);
    }

    const surface = apexSurface(url.pathname);
    if (surface === "homepage") {
      return withPreviewStage(await env.Homepage.fetch(request), stage);
    }
    if (surface === "dashboard") {
      return withPreviewStage(await env.Dashboard.fetch(request), stage);
    }

    // server surface (/api/* and /health): proxy through the dedicated
    // origin-api tunnel. The browser stays on the apex origin.
    return withPreviewStage(
      proxyResponse(
        await fetch(
          new Request(backendUrl(url), {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: "manual",
            duplex: "half",
          } as RequestInit),
        ),
      ),
      stage,
    );
  },
};
