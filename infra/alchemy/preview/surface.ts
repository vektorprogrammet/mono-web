export type PreviewSurface = "homepage" | "dashboard" | "server";

export function previewSurface(pathname: string): PreviewSurface {
  if (pathname === "/health" || pathname === "/api" || pathname.startsWith("/api/")) {
    return "server";
  }
  if (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/login" ||
    pathname === "/logout" ||
    pathname === "/glemt-passord" ||
    pathname === "/tilbakestill-passord" ||
    pathname.startsWith("/tilbakestill-passord/")
  ) {
    return "dashboard";
  }
  return "homepage";
}
