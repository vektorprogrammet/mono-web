import createFetchClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import type { paths } from "../generated/api.js";

export function createQueryApi(
  baseUrl: string,
  options?: Parameters<typeof createFetchClient>[0],
) {
  const fetchClient = createFetchClient<paths>({ baseUrl, ...options });
  return createQueryClient(fetchClient);
}

export type QueryApi = ReturnType<typeof createQueryApi>;
