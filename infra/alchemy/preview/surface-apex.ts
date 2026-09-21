/**
 * Apex-specific surface classifier (owned by the apex stack; the shared
 * preview/surface.ts keeps the frozen p20 contract untouched).
 *
 * Differences from the p20 classifier:
 *   - react-router single-fetch requests carry a `.data` suffix on the
 *     document path (e.g. `/login.data`); classify them by source route.
 *   - dashboard route families remain on the dashboard worker for both
 *     document and normalized `.data` requests.
 */
export type ApexSurface = "homepage" | "dashboard" | "server";

const DASHBOARD_ROUTE_ROOTS: Record<string, true> = {
  "/content": true,
  "/dashboard": true,
  "/glemt-passord": true,
  "/interview": true,
  "/interview-response": true,
  "/login": true,
  "/logout": true,
  "/profile": true,
  "/recruitment": true,
  "/schools": true,
  "/tilbakestill-passord": true,
  "/undersokelse": true,
};

const normalizedRoutePath = (pathname: string): string =>
  pathname.endsWith(".data") ? pathname.slice(0, -".data".length) : pathname;

const isDashboardRoute = (pathname: string): boolean => {
  const routePath = normalizedRoutePath(pathname);
  for (const root in DASHBOARD_ROUTE_ROOTS) {
    if (routePath === root || routePath.startsWith(`${root}/`)) return true;
  }
  return false;
};

export function apexSurface(pathname: string): ApexSurface {
  const url = new URL(pathname, "https://surface.invalid");
  if (url.pathname === "/health" || url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    return "server";
  }
  if (url.pathname === "/__manifest") {
    const requestedPaths = url.searchParams
      .getAll("paths")
      .flatMap((paths) => paths.split(","))
      .filter((path) => path !== "");
    return requestedPaths.some((path) => isDashboardRoute(new URL(path, url).pathname))
      ? "dashboard"
      : "homepage";
  }
  return isDashboardRoute(url.pathname) ? "dashboard" : "homepage";
}
