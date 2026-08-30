import { createClient } from "@vektorprogrammet/sdk";

export function createHomepageApiClient() {
  const runtimeApiUrl = typeof process === "undefined" ? undefined : process.env.API_URL;
  return createClient(runtimeApiUrl);
}
