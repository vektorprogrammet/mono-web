export { createClient, type ApiClient } from "./client";
export { createQueryApi, type QueryApi } from "./query";
export { QueryProvider } from "./provider";
export { apiUrl, isFixtureMode } from "./config";
export type { paths } from "../generated/api";

// Pre-configured instances using VITE_API_URL (or Railway staging default)
import { createClient } from "./client";
import { createQueryApi } from "./query";
import { apiUrl } from "./config";

export const apiClient = createClient(apiUrl);
export const $api = createQueryApi(apiUrl);
