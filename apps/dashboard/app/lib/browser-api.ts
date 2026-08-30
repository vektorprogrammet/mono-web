export function resolveBrowserApiUrl(
  configuredUrl: string | undefined,
  browserOrigin: string,
): string {
  if (configuredUrl === undefined || configuredUrl.trim() === "") {
    throw new Error("VITE_API_URL is not configured");
  }
  const configured = new URL(configuredUrl);
  const current = new URL(browserOrigin);
  if (configured.origin !== current.origin) {
    throw new Error("VITE_API_URL must match the dashboard origin");
  }
  return current.origin;
}
