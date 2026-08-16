import { createClient, type ClientOptions } from "@vektorprogrammet/sdk";

export type AuthOption = NonNullable<ClientOptions["auth"]>;

const serverApiUrl =
  typeof process !== "undefined" ? process.env?.API_URL : undefined;

export function createAuthenticatedClient(auth: AuthOption) {
  return createClient(serverApiUrl, { auth });
}

export function createServerClient() {
  return createClient(serverApiUrl);
}
