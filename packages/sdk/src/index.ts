export { createClient, type ApiClient } from "./client.js";
export { createQueryApi, type QueryApi } from "./query.js";
export { QueryProvider } from "./provider.js";
export { apiUrl, isFixtureMode } from "./config.js";
export type { paths } from "../generated/api.js";

// Pre-configured instances using VITE_API_URL (or Railway staging default)
import { createClient } from "./client.js";
import { createQueryApi } from "./query.js";
import { apiUrl } from "./config.js";

export const apiClient = createClient(apiUrl);
export const $api = createQueryApi(apiUrl);
