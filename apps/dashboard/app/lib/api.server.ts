import { createPromiseClient, type ClientOptions } from "@vektorprogrammet/sdk";

export type CookieOption = NonNullable<ClientOptions["cookie"]>;

const serverApiUrl = typeof process !== "undefined" ? process.env?.API_URL : undefined;
const tracedFetch: typeof globalThis.fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init);
  if (String(input).includes("/api/placements")) {
    console.error("placement-backend-response", response.status, await response.clone().text());
  }
  return response;
};

export function createAuthenticatedClient(cookie: CookieOption, request: Request) {
  return createPromiseClient(serverApiUrl, {
    cookie,
    origin: new URL(request.url).origin,
    fetch: tracedFetch,
  });
}

export function createServerClient() {
  return createPromiseClient(serverApiUrl);
}

export function serverApiEndpoint(path: string): string {
  if (serverApiUrl === undefined || serverApiUrl.trim() === "") {
    throw new Error("API URL is not configured");
  }
  return new URL(path, serverApiUrl).toString();
}
