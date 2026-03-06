import { createClient } from "@vektorprogrammet/sdk";
import { apiUrl } from "@vektorprogrammet/sdk";
import { createAuthHeaders } from "./auth.server";

export function createAuthenticatedClient(token: string) {
  return createClient(apiUrl, { headers: createAuthHeaders(token) });
}
