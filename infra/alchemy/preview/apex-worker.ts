/**
 * Apex edge worker (stage dev-main, hostname vektor.phibkro.org).
 *
 * Routing contract:
 *   /api/*  -> native backend origin (api.vektor.phibkro.org, cloudflared
 *              tunnel to the authority host running next to Postgres)
 *   /dashboard* and auth pages -> Dashboard Website.Vite worker
 *   else    -> Homepage Website.Vite worker
 *
 * Additive to p20: shares zero resources with the p20 stack; every physical
 * resource name is prefixed `vektor-apex-`.
 */
import { APEX_IDENTITY } from "./identity.ts";
import { previewSurface } from "./surface.ts";

interface ApexService {
  fetch(request: Request): Promise<Response>;
}

export interface ApexWorkerEnv {
  readonly Homepage: ApexService;
  readonly Dashboard: ApexService;
}

/**
 * Worker→own-custom-domain subrequests are restricted on Cloudflare, so the
 * proxy targets a dedicated tunnel hostname that bypasses every worker.
 */
export const BACKEND_ORIGIN = "https://origin-api.vektor.phibkro.org";

const ALLOWED_HOSTS: Record<string, true> = {
  [APEX_IDENTITY.hostname]: true,
  [APEX_IDENTITY.apiHostname]: true,
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
    headers.set("location", `${APEX_IDENTITY.hostname}${location.slice(BACKEND_ORIGIN.length)}`);
  }
  return new Response(backendResponse.body, {
    status: backendResponse.status,
    statusText: backendResponse.statusText,
    headers,
  });
};

const backendUrl = (url: URL): URL =>
  new URL(`${url.pathname}${url.search}`, BACKEND_ORIGIN);

export default {
  async fetch(request: Request, env: ApexWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const host = request.headers.get("host")?.toLowerCase() ?? "";

    if (!(host in ALLOWED_HOSTS) || host.includes(APEX_IDENTITY.forbiddenHost)) {
      return new Response("Forbidden apex destination", {
        status: 421,
        headers: { "cache-control": "no-store" },
      });
    }

    const surface = previewSurface(url.pathname);
    // Dashboard pages reference hashed bundles at /assets/* and the shared
    // logo at /vektor-logo-circle.svg — paths previewSurface classifies as
    // homepage. When the navigation context (Referer) identifies a dashboard
    // document, serve these subresources from the dashboard worker instead.
    if (
      surface === "homepage" &&
      isDashboardAssetRequest(request)
    ) {
      return env.Dashboard.fetch(request);
    }
    if (surface === "homepage") return env.Homepage.fetch(request);
    if (surface === "dashboard") return env.Dashboard.fetch(request);


    // server surface (/api/* and /health): proxy to the backend origin,
    // reached through the cloudflared tunnel on both allowed hostnames.
    return proxyResponse(
      await fetch(new Request(backendUrl(url), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        duplex: "half",
      } as RequestInit)),
    );
  },
};

/**
 * Subresources belong to whichever app rendered the referencing document.
 * A Referer whose path maps to the dashboard surface (including react-router
 * `.data` requests for dashboard routes) is served by the dashboard worker;
 * everything else stays on the homepage. Requests without a Referer default
 * to the homepage, matching direct navigation of homepage-owned paths.
 */
const isDashboardAssetRequest = (request: Request): boolean => {
  // Only subresources can be re-routed; document navigations must keep the
  // pathname-based surface so "/" stays on the homepage.
  const dest = request.headers.get("sec-fetch-dest");
  if (dest === null || dest === "" || dest === "document") return false;

  const referer = request.headers.get("referer");
  if (referer === null) return true;
  try {
    const refererPath = new URL(referer).pathname;
    // Module chains report the importing script as the referer; dashboard
    // route modules are imported by other /assets/* scripts, so treat an
    // asset referer as dashboard context instead of misrouting to homepage.
    if (refererPath.startsWith("/assets/")) return true;
    return previewSurface(refererPath) === "dashboard";
  } catch {
    return true;
  }
};
