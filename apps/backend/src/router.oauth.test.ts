import { describe, expect, it, vi } from "vitest";
import { makeBackendHttp, makeInternalBackendHttp, type BackendAuthHandler } from "./router.js";
import type { NativeSessionBoundaryPolicy } from "./session-security.js";

const sessionBoundary: NativeSessionBoundaryPolicy = {
  deployment: "local",
  trustedOrigins: ["http://127.0.0.1:4173"],
  secureCookies: false,
};

const makeAuth = (): BackendAuthHandler => ({
  handle: vi.fn(async () => Response.json({ surface: "identity" })),
  handleOAuth: vi.fn(async () => Response.json({ surface: "oauth" })),
  handleOAuthIntrospection: vi.fn(async () => Response.json({ active: true })),
  exactRedirectAccepted: vi.fn(
    async (_clientId, redirectUri) =>
      redirectUri === "http://127.0.0.1:4173/dashboard/oauth/callback",
  ),
  recordTrustedOriginRejection: vi.fn(async () => undefined),
});

const authorizeUrl = new URL("http://127.0.0.1:4173/api/auth/oauth2/authorize");
authorizeUrl.searchParams.set("client_id", "delegated-client");
authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:4173/dashboard/oauth/callback");
authorizeUrl.searchParams.set("state", "s".repeat(43));
authorizeUrl.searchParams.set("code_challenge", "a".repeat(43));
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("resource", "urn:vektorprogrammet:native-api");
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("scope", "native-api offline_access");

const allowedRoutes = [
  ["GET", "http://127.0.0.1:4173/.well-known/oauth-authorization-server/api/auth"],
  ["GET", "http://127.0.0.1:4173/api/auth/jwks"],
  ["GET", authorizeUrl.toString()],
  ["GET", "http://127.0.0.1:4173/api/auth/oauth2/public-client"],
  ["POST", "http://127.0.0.1:4173/api/auth/oauth2/consent"],
  ["POST", "http://127.0.0.1:4173/api/auth/oauth2/token"],
  ["POST", "http://127.0.0.1:4173/api/auth/oauth2/revoke"],
  ["GET", "http://127.0.0.1:4173/api/auth/oauth2/get-consents"],
  ["POST", "http://127.0.0.1:4173/api/auth/oauth2/delete-consent"],
] as const;

describe("frozen external OAuth ingress", () => {
  it.each(allowedRoutes)("dispatches only %s %s to the OAuth graph", async (method, url) => {
    const auth = makeAuth();
    const http = makeBackendHttp(
      vi.fn(async () => new Response("native")),
      auth,
      sessionBoundary,
    );

    const browserMutation = url.endsWith("/consent") || url.endsWith("/delete-consent");
    const response = await http.fetch(
      new Request(url, {
        method,
        ...(browserMutation ? { headers: { origin: "http://127.0.0.1:4173" } } : {}),
      }),
    );

    expect(response.status).toBe(200);
    expect(auth.handleOAuth).toHaveBeenCalledTimes(1);
    expect(auth.handle).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "http://127.0.0.1:4173/api/auth/oauth2/authorize"],
    ["POST", "http://127.0.0.1:4173/api/auth/oauth2/introspect"],
    ["POST", "http://127.0.0.1:4173/api/auth/oauth2/register"],
    ["POST", "http://127.0.0.1:4173/api/auth/admin/oauth2/create-client"],
    ["GET", "http://127.0.0.1:4173/api/auth/userinfo"],
  ])("returns route-not-found for %s %s", async (method, url) => {
    const auth = makeAuth();
    const http = makeBackendHttp(vi.fn(), auth, sessionBoundary);

    const response = await http.fetch(new Request(url, { method }));

    expect(response.status).toBe(404);
    expect(auth.handleOAuth).not.toHaveBeenCalled();
    expect(auth.handle).not.toHaveBeenCalled();
  });

  it("does not dispatch an unregistered redirect and never reflects OAuth CORS", async () => {
    const auth = makeAuth();
    const http = makeBackendHttp(vi.fn(), auth, sessionBoundary);
    const wrong = new URL(authorizeUrl);
    wrong.searchParams.set("redirect_uri", "http://127.0.0.1:4173/other");

    const denied = await http.fetch(new Request(wrong));
    const token = await http.fetch(
      new Request("http://127.0.0.1:4173/api/auth/oauth2/token", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:4173" },
      }),
    );

    expect(denied.status).toBe(400);
    expect(denied.headers.get("location")).toBeNull();
    expect(auth.handleOAuth).toHaveBeenCalledTimes(1);
    expect(token.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("independent internal OAuth ingress", () => {
  it("reveals no token signal to a wrong network", async () => {
    const auth = makeAuth();
    const http = makeInternalBackendHttp(vi.fn(), auth, ["10.20.0.0/16"]);

    const response = await http.fetch(
      new Request("http://127.0.0.1:4173/api/auth/oauth2/introspect", {
        method: "POST",
        headers: { "x-real-ip": "10.21.0.1" },
      }),
    );

    await expect(response.json()).resolves.toEqual({ active: false });
    expect(auth.handleOAuthIntrospection).not.toHaveBeenCalled();
  });

  it("dispatches only POST introspection from an allowed source", async () => {
    const auth = makeAuth();
    const http = makeInternalBackendHttp(vi.fn(), auth, ["10.20.0.0/16"]);
    const url = "http://127.0.0.1:4173/api/auth/oauth2/introspect";

    const accepted = await http.fetch(
      new Request(url, { method: "POST", headers: { "x-real-ip": "10.20.4.5" } }),
    );
    const rejectedMethod = await http.fetch(
      new Request(url, { headers: { "x-real-ip": "10.20.4.5" } }),
    );

    expect(accepted.status).toBe(200);
    expect(rejectedMethod.status).toBe(404);
    expect(auth.handleOAuthIntrospection).toHaveBeenCalledTimes(1);
    expect(auth.handleOAuth).not.toHaveBeenCalled();
  });
});
