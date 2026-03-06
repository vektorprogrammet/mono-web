import createFetchClient from "openapi-fetch";
import type { paths } from "../generated/api";

export function createClient(
  baseUrl: string,
  options?: Parameters<typeof createFetchClient>[0],
) {
  return createFetchClient<paths>({ baseUrl, ...options });
}

export type ApiClient = ReturnType<typeof createClient>;
