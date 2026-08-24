import { createClient, type ClientOptions } from "@vektorprogrammet/sdk";

export type CookieOption = NonNullable<ClientOptions["cookie"]>;

const serverApiUrl =
  typeof process !== "undefined" ? process.env?.API_URL : undefined;

export function createAuthenticatedClient(cookie: CookieOption) {
  return createClient(serverApiUrl, { cookie });
}

export function createServerClient() {
  return createClient(serverApiUrl);
}

export function serverApiEndpoint(path: string): string {
  if (serverApiUrl === undefined || serverApiUrl.trim() === "") {
    throw new Error("API URL is not configured");
  }
  return new URL(path, serverApiUrl).toString();
}
