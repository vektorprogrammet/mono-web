export type PreviewSurface = "homepage" | "dashboard" | "server";

export function previewSurface(pathname: string): PreviewSurface {
  if (pathname === "/health" || pathname === "/api" || pathname.startsWith("/api/")) {
    return "server";
  }
  // React Router single-fetch data requests carry a `.data` suffix on the
  // document path (e.g. `/login.data`); classify them by their source route.
  const routePath = pathname.endsWith(".data") ? pathname.slice(0, -".data".length) : pathname;
  if (
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
