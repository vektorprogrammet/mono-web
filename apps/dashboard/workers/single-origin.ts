/**
 * Routing decision for serving the homepage, the dashboard, and the backend API
 * from one public origin.
 *
 * This module has no Cloudflare types and does no I/O. It decides where a
 * request goes and how a backend redirect maps onto the public origin. A future
 * single-origin edge adapter composes it with its own application bindings and
 * backend transport.
 *
 * It lives in the dashboard because the dashboard owns the route families that
 * leave the homepage, and this directory already holds the dashboard's edge code.
 */

export type SingleOriginApplication = "homepage" | "dashboard";

/**
 * - An application kind forwards the request to that application.
 * - `asset` forwards the request to the preferred application and, only when it
 *   answers 404, to the fallback application.
 * - `redirect` answers without forwarding the request.
 * - `backend` forwards the request to `path` (path and query) on the backend origin.
 */
export type SingleOriginTarget =
  | { readonly kind: SingleOriginApplication }
  | {
      readonly kind: "asset";
      readonly order: readonly [
        preferred: SingleOriginApplication,
        fallback: SingleOriginApplication,
      ];
    }
  | { readonly kind: "redirect"; readonly status: 302; readonly location: string }
  | { readonly kind: "backend"; readonly path: string };

/**
 * First path segments of the dashboard route config at the root mount. `/` and
 * every other page belong to the homepage. The tests check this list against
 * the route files of both applications.
 */
const DASHBOARD_ROUTE_FAMILIES = {
  content: true,
  dashboard: true,
  "glemt-passord": true,
  interview: true,
  "interview-response": true,
  "konto-aktivering": true,
  login: true,
  logout: true,
  oauth: true,
  profile: true,
  recruitment: true,
  "social-events": true,
  "tilbakestill-passord": true,
} as const satisfies Record<string, true>;

const SINGLE_FETCH_SUFFIX = ".data";

const HOMEPAGE: SingleOriginTarget = { kind: "homepage" };

const DASHBOARD: SingleOriginTarget = { kind: "dashboard" };

/**
 * Both builds emit root-relative fingerprinted assets. Each build stays the
 * authority for its own asset manifest.
 */
const ASSET: SingleOriginTarget = { kind: "asset", order: ["dashboard", "homepage"] };

/** The first-class probe reaches the backend's own `/health`, independent of API route matching. */
const BACKEND_HEALTH: SingleOriginTarget = { kind: "backend", path: "/health" };

/** React Router single-fetch requests carry a `.data` suffix on the document path. */
const isDashboardRoute = (pathname: string): boolean => {
  const routePath = pathname.endsWith(SINGLE_FETCH_SUFFIX)
    ? pathname.slice(0, -SINGLE_FETCH_SUFFIX.length)
    : pathname;

  const familyEnd = routePath.indexOf("/", 1);

  // `Object.hasOwn`, not `in`: inherited names such as `constructor` are not route families.
  return Object.hasOwn(
    DASHBOARD_ROUTE_FAMILIES,
    familyEnd === -1 ? routePath.slice(1) : routePath.slice(1, familyEnd),
  );
};

export const singleOriginTarget = (request: {
  readonly method: string;
  readonly url: string;
}): SingleOriginTarget => {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/api/health" && request.method === "GET") return BACKEND_HEALTH;

  // Legacy Symfony bookmark: the exact path, as a document or single-fetch request.
  if (pathname === "/kontrollpanel" || pathname === `/kontrollpanel${SINGLE_FETCH_SUFFIX}`) {
    return {
      kind: "redirect",
      status: 302,
      location: `/login${url.search || "?redirectTo=%2Fdashboard"}`,
    };
  }

  // Only reads fall back: a request body cannot be replayed to the second application.
  if ((request.method === "GET" || request.method === "HEAD") && pathname.startsWith("/assets/")) {
    return ASSET;
  }

  if (pathname === "/health" || pathname === "/api" || pathname.startsWith("/api/")) {
    return { kind: "backend", path: `${pathname}${url.search}` };
  }

  // Both applications serve lazy route discovery; the requested paths name the owner.
  if (pathname === "/__manifest") {
    const requestsDashboardRoute = url.searchParams.getAll("paths").some((paths) =>
      paths.split(",").some((path) => {
        const requested = URL.parse(path, url);

        return requested !== null && isDashboardRoute(requested.pathname);
      }),
    );

    return requestsDashboardRoute ? DASHBOARD : HOMEPAGE;
  }

  return isDashboardRoute(pathname) ? DASHBOARD : HOMEPAGE;
};

/**
 * Maps a backend redirect onto the public origin. Only a Location that resolves
 * to the exact backend origin is rewritten. Authority-relative (`//`), foreign,
 * credentialed, and unparseable locations return `undefined`, so the adapter
 * blocks the response before its Location or Set-Cookie reaches the browser.
 * Both origins are serialized origins (`scheme://host[:port]`).
 */
export const rewriteBackendRedirect = (
  location: string,
  backendOrigin: string,
  publicOrigin: string,
): string | undefined => {
  const redirect = location.startsWith("//") ? null : URL.parse(location, `${backendOrigin}/`);

  if (
    redirect === null ||
    redirect.origin !== backendOrigin ||
    redirect.username !== "" ||
    redirect.password !== ""
  ) {
    return undefined;
  }

  // Assign the parts instead of reparsing them, so a `//` path cannot become an authority.
  const rewritten = new URL(publicOrigin);
  rewritten.pathname = redirect.pathname;
  rewritten.search = redirect.search;
  rewritten.hash = redirect.hash;

  return rewritten.href;
};
