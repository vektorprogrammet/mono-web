const HEALTH_BODY =
  '{ "service": "mono-web", "purpose": "cloudflare-local-preview-spine", "status": "ok" }';

const HEALTH_HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  "Cache-Control": "no-store",
};

export default {
  fetch(request: Request) {
    const { pathname } = new URL(request.url);

    if (pathname !== "/health") {
      return new Response(null, { status: 404 });
    }

    if (request.method !== "GET") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    return new Response(HEALTH_BODY, {
      status: 200,
      headers: HEALTH_HEADERS,
    });
  },
};
