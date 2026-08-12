import { getContainer } from "@cloudflare/containers";
import type * as Cloudflare from "alchemy/Cloudflare";
import type { PreviewWorker } from "./worker-resource.ts";

export default {
  async fetch(request: Request, env: Cloudflare.InferEnv<typeof PreviewWorker>): Promise<Response> {
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    if (host === "vektorprogrammet.no" || host.endsWith(".vektorprogrammet.no")) {
      return new Response("Forbidden preview destination", { status: 421, headers: { "cache-control": "no-store" } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    return getContainer(env.PreviewContainer, "vektor-p20-container").fetch(request);
  },
};
