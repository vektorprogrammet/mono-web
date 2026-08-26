/**
 * Apex-specific surface classifier (owned by the apex stack; the shared
 * preview/surface.ts keeps the frozen p20 contract untouched).
 *
 * Differences from the p20 classifier:
 *   - react-router single-fetch requests carry a `.data` suffix on the
 *     document path (e.g. `/login.data`); classify them by source route.
 *   - `/schools` is the dashboard's authenticated Foldkit bridge route.
 */
export type ApexSurface = "homepage" | "dashboard" | "server";

export function apexSurface(pathname: string): ApexSurface {
  if (pathname === "/health" || pathname === "/api" || pathname.startsWith("/api/")) {
    return "server";
  }
  const routePath = pathname.endsWith(".data") ? pathname.slice(0, -".data".length) : pathname;
  if (
    routePath === "/schools" ||
    routePath === "/dashboard" ||
    routePath.startsWith("/dashboard/") ||
    routePath === "/login" ||
    routePath === "/logout" ||
    routePath === "/glemt-passord" ||
    routePath === "/tilbakestill-passord" ||
    routePath.startsWith("/tilbakestill-passord/")
  ) {
    return "dashboard";
  }
  return "homepage";
}
