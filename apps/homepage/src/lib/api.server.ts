import { createClient } from "@vektorprogrammet/sdk";

declare const __HOMEPAGE_API_URL__: string | null;

export function createHomepageApiClient() {
  const buildApiUrl = typeof __HOMEPAGE_API_URL__ === "undefined" ? null : __HOMEPAGE_API_URL__;
  const runtimeApiUrl = typeof process === "undefined" ? undefined : process.env.API_URL;
  return createClient(buildApiUrl ?? runtimeApiUrl);
}
