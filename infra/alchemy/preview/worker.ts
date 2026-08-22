import { Container, getContainer } from "@cloudflare/containers";
import { PREVIEW_IDENTITY } from "./identity.ts";
import { previewSurface } from "./surface.ts";

type PreviewContainerNamespace = Parameters<typeof getContainer<PreviewContainer>>[0];

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

interface PreviewService {
  fetch(request: Request): Promise<Response>;
}

export interface PreviewWorkerEnv {
  readonly Homepage: PreviewService;
  readonly Dashboard: PreviewService;
  readonly PreviewContainer: PreviewContainerNamespace;
}

export default {
  async fetch(request: Request, env: PreviewWorkerEnv): Promise<Response> {
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    if (host !== PREVIEW_IDENTITY.hostname) {
      return new Response("Forbidden preview destination", {
        status: 421,
        headers: { "cache-control": "no-store" },
      });
    }
    const surface = previewSurface(new URL(request.url).pathname);
    if (surface === "homepage") return env.Homepage.fetch(request);
    if (surface === "dashboard") return env.Dashboard.fetch(request);
    return getContainer(env.PreviewContainer, "vektor-p20-container").fetch(request);
  },
};
