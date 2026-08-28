interface ApexService {
  fetch(request: Request): Promise<Response>;
}

interface ApexWorkerEnv {
  readonly Homepage: ApexService;
  readonly Dashboard: ApexService;
}

export const BACKEND_ORIGIN = "https://origin-api.example.test";

const backendUrl = (url: URL): URL => new URL(`${url.pathname}${url.search}`, BACKEND_ORIGIN);

export default {
  async fetch(request: Request, env: ApexWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return fetch(new Request(backendUrl(new URL("/health", url.origin))));
    }
    if (url.pathname === "/logo.svg") return env.Homepage.fetch(request);
    if (url.pathname === "/") return env.Homepage.fetch(request);
    if (url.pathname === "/dashboard") return env.Dashboard.fetch(request);
    return fetch(new Request(backendUrl(url), request));
  },
};
