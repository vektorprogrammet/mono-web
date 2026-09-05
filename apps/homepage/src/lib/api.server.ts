import { createPromiseClient } from "@vektorprogrammet/sdk";

export function createHomepageApiClient(explicitOrigin?: string) {
  const runtimeApiUrl = typeof process === "undefined" ? undefined : process.env.API_URL;
  return createPromiseClient(explicitOrigin ?? runtimeApiUrl);
}
