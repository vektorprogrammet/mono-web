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
};

export function apexSurface(pathname: string): ApexSurface {
  if (pathname === "/health" || pathname === "/api" || pathname.startsWith("/api/")) {
    return "server";
  }
  const routePathWithQuery = pathname.split(/[?#]/u, 1)[0] ?? pathname;
  const routePath = routePathWithQuery.endsWith(".data")
    ? routePathWithQuery.slice(0, -".data".length)
    : routePathWithQuery;
  for (const root in DASHBOARD_ROUTE_ROOTS) {
    if (routePath === root || routePath.startsWith(`${root}/`)) {
      return "dashboard";
    }
  }
  return "homepage";
}
