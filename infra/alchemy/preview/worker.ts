import { Container, getContainer } from "@cloudflare/containers";

type PreviewContainerNamespace = Parameters<
  typeof getContainer<PreviewContainer>
>[0];

/**
 * Container-backed Durable Object for the p20 Symfony + MariaDB image.
 *
 * The class is part of the Worker bundle because beta.70 async bindings use
 * the exported Durable Object class as the container binding's shape.
 */
export class PreviewContainer extends Container {
  defaultPort = 8000;
  enableInternet = false;
  deniedHosts = ["vektorprogrammet.no", "*.vektorprogrammet.no"];
}

export interface PreviewWorkerEnv {
  readonly PreviewContainer: PreviewContainerNamespace;
}

export default {
  async fetch(
    request: Request,
    env: PreviewWorkerEnv,
  ): Promise<Response> {
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
