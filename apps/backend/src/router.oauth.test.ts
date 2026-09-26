import { describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import {
  backendHttpHandler,
  internalBackendHttpHandler,
  type BackendAuthHandler,
} from "./router.js";
import type { NativeSessionBoundaryPolicy } from "./session-security.js";

const sessionBoundary: NativeSessionBoundaryPolicy = {
  deployment: "local",
  trustedOrigins: ["http://127.0.0.1:4173"],
  secureCookies: false,
};

const makeAuth = (): BackendAuthHandler => ({
  handler: vi.fn(() => Effect.succeed(Response.json({ surface: "identity" }))),
  oauthHandler: vi.fn(() => Effect.succeed(Response.json({ surface: "oauth" }))),
  oauthIntrospectionHandler: vi.fn(() => Effect.succeed(Response.json({ active: true }))),
  exactRedirectAccepted: vi.fn((_clientId, redirectUri) =>
    Effect.succeed(redirectUri === "http://127.0.0.1:4173/dashboard/oauth/callback"),
  ),
  recordTrustedOriginRejection: vi.fn(() => Effect.void),
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
  it.effect.each(allowedRoutes)("dispatches only %s %s to the OAuth graph", ([method, url]) =>
    Effect.gen(function* () {
      const auth = makeAuth();

      const http = backendHttpHandler(
        vi.fn(() => Effect.succeed(new Response("native"))),
        auth,
        sessionBoundary,
      );

      const browserMutation = url.endsWith("/consent") || url.endsWith("/delete-consent");

      const response = yield* http(
        new Request(url, {
          method,
          headers: browserMutation ? { origin: "http://127.0.0.1:4173" } : undefined,
        }),
      );

      expect(response.status).toBe(200);
      expect(auth.oauthHandler).toHaveBeenCalledTimes(1);
      expect(auth.handler).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    ["POST", "http://127.0.0.1:4173/api/auth/oauth2/authorize"],
    ["POST", "http://127.0.0.1:4173/api/auth/oauth2/introspect"],
    ["POST", "http://127.0.0.1:4173/api/auth/oauth2/register"],
    ["POST", "http://127.0.0.1:4173/api/auth/admin/oauth2/create-client"],
    ["GET", "http://127.0.0.1:4173/api/auth/userinfo"],
  ] as const)("returns route-not-found for %s %s", ([method, url]) =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const http = backendHttpHandler(vi.fn(), auth, sessionBoundary);

      const response = yield* http(new Request(url, { method }));

      expect(response.status).toBe(404);
      expect(auth.oauthHandler).not.toHaveBeenCalled();
      expect(auth.handler).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not dispatch an unregistered redirect and never reflects OAuth CORS", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const http = backendHttpHandler(vi.fn(), auth, sessionBoundary);
      const wrong = new URL(authorizeUrl);
      wrong.searchParams.set("redirect_uri", "http://127.0.0.1:4173/other");

      const denied = yield* http(new Request(wrong));

      const token = yield* http(
        new Request("http://127.0.0.1:4173/api/auth/oauth2/token", {
          method: "POST",
          headers: { origin: "http://127.0.0.1:4173" },
        }),
      );

      expect(denied.status).toBe(400);
      expect(denied.headers.get("location")).toBeNull();
      expect(auth.oauthHandler).toHaveBeenCalledTimes(1);
      expect(token.headers.get("access-control-allow-origin")).toBeNull();
    }),
  );
});

describe("independent internal OAuth ingress", () => {
  it.effect("reveals no token signal to a wrong network", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const http = internalBackendHttpHandler(vi.fn(), auth, ["10.20.0.0/16"]);

      const response = yield* http(
        new Request("http://127.0.0.1:4173/api/auth/oauth2/introspect", {
          method: "POST",
          headers: { "x-real-ip": "10.21.0.1" },
        }),
      );

      expect(yield* Effect.promise(() => response.json())).toEqual({ active: false });
      expect(auth.oauthIntrospectionHandler).not.toHaveBeenCalled();
    }),
  );

  it.effect("dispatches only POST introspection from an allowed source", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const http = internalBackendHttpHandler(vi.fn(), auth, ["10.20.0.0/16"]);
      const url = "http://127.0.0.1:4173/api/auth/oauth2/introspect";

      const accepted = yield* http(
        new Request(url, { method: "POST", headers: { "x-real-ip": "10.20.4.5" } }),
      );

      const rejectedMethod = yield* http(
        new Request(url, { headers: { "x-real-ip": "10.20.4.5" } }),
      );

      expect(accepted.status).toBe(200);
      expect(rejectedMethod.status).toBe(404);
      expect(auth.oauthIntrospectionHandler).toHaveBeenCalledTimes(1);
      expect(auth.oauthHandler).not.toHaveBeenCalled();
    }),
  );
});
