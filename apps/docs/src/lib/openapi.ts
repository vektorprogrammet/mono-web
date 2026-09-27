import { resolve } from "node:path";
import { createOpenAPI } from "fumadocs-openapi/server";

/** The site runs from apps/docs; a bundled server file no longer sits beside this source. */
export const openapi = createOpenAPI({
  input: [resolve(process.cwd(), "../../packages/http-api/openapi.json")],
});
