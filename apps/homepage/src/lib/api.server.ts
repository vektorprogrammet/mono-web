import { createClient } from "@vektorprogrammet/sdk";

export function createHomepageApiClient() {
  const apiUrl = typeof process !== "undefined" ? process.env.API_URL : undefined;
  return createClient(apiUrl);
}
