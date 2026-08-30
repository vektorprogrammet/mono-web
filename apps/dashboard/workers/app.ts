import { createRequestHandler, RouterContextProvider } from "react-router";
import { validateDashboardPreviewStage } from "./preview-stage";

type DashboardEnv = {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  readonly PREVIEW_HOST: string;
  readonly PREVIEW_STAGE: string;
};

type DashboardExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
};

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const isStaticAssetPath = (pathname: string): boolean => {
  const last = pathname.split("/").at(-1);
  return (
    pathname.startsWith("/assets/") || (last?.includes(".") === true && !pathname.endsWith(".data"))
  );
};

const withPreviewHeaders = (response: Response, host: string, stage: string): Response => {
  const headers = new Headers(response.headers);
  headers.set("X-Mono-Web-Stage", stage);
  headers.set("X-Mono-Web-Host", host);
  headers.set("X-Robots-Tag", "noindex");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export default {
  async fetch(
    request: Request,
    env: DashboardEnv,
    _ctx: DashboardExecutionContext,
  ): Promise<Response> {
    let stage: string;
    try {
      stage = validateDashboardPreviewStage(env.PREVIEW_STAGE, env.PREVIEW_HOST);
    } catch {
      return new Response("Invalid dashboard preview stage", {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const host = request.headers.get("host")?.toLowerCase() ?? "";
    if (host !== env.PREVIEW_HOST) {
      return new Response("Unsupported dashboard host", {
        status: 421,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const url = new URL(request.url);
    if (isStaticAssetPath(url.pathname)) {
      return withPreviewHeaders(await env.ASSETS.fetch(request), host, stage);
    }

    const response = await requestHandler(request, new RouterContextProvider());
    return withPreviewHeaders(response, host, stage);
  },
};
