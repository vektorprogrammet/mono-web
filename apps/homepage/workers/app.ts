import { createRequestHandler, RouterContextProvider } from "react-router";

import {
  BUILD_COMMIT,
  BUILD_CONTENT_DIGEST,
  BUILD_ROUTE_DIGEST,
} from "../src/lib/build-provenance";
import { DEV_CONTENT_SOURCE } from "../src/lib/dev-content";
import { resolveHomepageRequest } from "../src/lib/host";
import type { HomepageRequest } from "../src/lib/host";

type HomepageEnv = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
};

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

function baseHeaders(stage: string, host: string): Headers {
  return new Headers({
    "X-Mono-Web-Stage": stage,
    "X-Mono-Web-Host": host,
    "X-Robots-Tag": "noindex",
  });
}

function invalidHostResponse(): Response {
  return new Response("Unsupported homepage host", {
    status: 421,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function healthResponse(request: Request, stage: string, host: string): Response {
  const headers = baseHeaders(stage, host);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "GET") {
    headers.set("Allow", "GET");
    return new Response(null, { status: 405, headers });
  }

  return new Response(
    JSON.stringify({
      stage,
      host,
      commit: BUILD_COMMIT,
      dataSource: DEV_CONTENT_SOURCE,
      routeDigest: BUILD_ROUTE_DIGEST,
      contentDigest: BUILD_CONTENT_DIGEST,
    }),
    { status: 200, headers },
  );
}

function withProvenance(response: Response, stage: string, host: string): Response {
  const headers = new Headers(response.headers);
  baseHeaders(stage, host).forEach((value, name) => {
    headers.set(name, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isStaticAssetPath(pathname: string): boolean {
  const last = pathname.split("/").at(-1);
  return (
    pathname.startsWith("/assets/") || (last?.includes(".") === true && !pathname.endsWith(".data"))
  );
}

export default {
  async fetch(request: Request, env: HomepageEnv): Promise<Response> {
    const rawHost = request.headers.get("host");
    if (!rawHost) return invalidHostResponse();

    let requestInfo: HomepageRequest;
    try {
      requestInfo = resolveHomepageRequest(rawHost);
    } catch {
      return invalidHostResponse();
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return healthResponse(request, requestInfo.stage, requestInfo.host);
    }

    if (isStaticAssetPath(url.pathname)) {
      return withProvenance(await env.ASSETS.fetch(request), requestInfo.stage, requestInfo.host);
    }

    const routerContext = new RouterContextProvider();
    const response = await requestHandler(request, routerContext);
    return withProvenance(response, requestInfo.stage, requestInfo.host);
  },
};
