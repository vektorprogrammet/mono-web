import { nativeFailureFrom } from "./lib/native-problem";
import { flow } from "effect";
import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

const STREAM_TIMEOUT_MS = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (
    pathname === `${import.meta.env.BASE_URL}login` ||
    pathname === `${import.meta.env.BASE_URL}oauth/consent`
  ) {
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.set("Pragma", "no-cache");
    // Keep native form Origin intact without exposing OAuth paths or query strings.
    responseHeaders.set("Referrer-Policy", "strict-origin");
  }

  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  let shellRendered = false;

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS + 1_000),
      onError() {
        responseStatusCode = 500;

        if (shellRendered) console.error("Dashboard stream failed");
      },
    },
  );

  shellRendered = true;

  const userAgent = request.headers.get("user-agent");

  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");

  return new Response(body, {
    status: responseStatusCode,
    headers: responseHeaders,
  });
}

/** Request errors may contain credential URLs; log only a bounded typed summary. */
export const handleError = flow(nativeFailureFrom, (error) => {
  const status = error instanceof Response ? String(error.status) : "unknown";

  const code =
    error instanceof Error || error instanceof Response ? "unknown" : (error?.code ?? "unknown");

  const kind = error instanceof Error ? error.name : "unknown";
  console.error(
    `Dashboard request failed phase=handler kind=${kind} status=${status} code=${code}`,
  );
});
