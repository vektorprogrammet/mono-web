import { Container, getContainer } from "@cloudflare/containers";

class PreviewContainer extends Container {
  defaultPort = 8000;
}

interface PreviewService {
  fetch(request: Request): Promise<Response>;
}

interface PreviewWorkerEnv {
  readonly Homepage: PreviewService;
  readonly Dashboard: PreviewService;
  readonly ContainerRuntime: Parameters<typeof getContainer<PreviewContainer>>[0];
}

export default {
  async fetch(request: Request, env: PreviewWorkerEnv): Promise<Response> {
    const surface = new URL(request.url).pathname;
    if (surface === "/") return env.Homepage.fetch(request);
    if (surface === "/dashboard") return env.Dashboard.fetch(request);
    return getContainer(env.ContainerRuntime, "preview").fetch(request);
  },
};
