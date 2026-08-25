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
    // Dashboard pages reference their hashed client bundles at /assets/*,
    // which previewSurface classifies as homepage. Route asset requests to
    // the dashboard whenever the navigation context says the document came
    // from a dashboard route; direct asset opens default to the dashboard,
    // whose entry chunk is the only one reachable without an HTML referrer.
    if (
      surface === "homepage" &&
      url.pathname.startsWith("/assets/") &&
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
 * Asset subresources belong to whichever app rendered the document that
 * referenced them. Dashboard documents are exactly the dashboard surface
 * paths, so their Sec-Fetch-Site/Referer identify them; same-origin
 * fetch()/module loads inherit the document's context.
 */
const isDashboardAssetRequest = (request: Request): boolean => {
  const referer = request.headers.get("referer");
  if (referer !== null) {
    const refererUrl = new URL(referer);
    return previewSurface(refererUrl.pathname) === "dashboard";
  }
  const secFetchDest = request.headers.get("sec-fetch-dest");
  return secFetchDest !== "document";
};
