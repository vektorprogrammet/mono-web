import createFetchClient from "openapi-fetch";
import type { paths } from "../generated/api.js";

export function createClient(
  baseUrl: string,
  options?: Parameters<typeof createFetchClient>[0],
) {
  return createFetchClient<paths>({ baseUrl, ...options });
}

export type ApiClient = ReturnType<typeof createClient>;
