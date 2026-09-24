import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeSessionResponse, routeArgs, sessionCookie } from "../test/native-http";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { action as loginAction, loader as loginLoader } from "./routes/login";
import { action as consentAction, loader as consentLoader } from "./routes/oauth.consent";

const origin = "http://127.0.0.1:5174";

const state = "s".repeat(43);

const pendingQuery = new URLSearchParams({
  client_id: "client", redirect_uri: `${origin}/dashboard/oauth/callback`, response_type: "code",
  state, code_challenge: "c".repeat(43), code_challenge_method: "S256",
  resource: "urn:vektorprogrammet:native-api", scope: "native-api offline_access",
  prompt: "consent", exp: "2000000000", ba_iat: "1900000000000", ba_param: "client_id", sig: "opaque",
}).toString();

const continuation = `${origin}/dashboard/oauth/consent?${pendingQuery}`;

const requests: Request[] = [];

let accepted = true;

beforeEach(() => {
  requests.length = 0;
  accepted = true;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const path = new URL(request.url).pathname;

    if (path === "/api/session") return nativeSessionResponse();

    if (path === "/api/auth/oauth2/public-client") return Response.json({ client_id: "client", client_name: "Dashboard OAuth proof", client_kind: "DelegatedPublic" });

    if (path === "/api/auth/sign-in/email") return Response.json({ redirect: true, url: continuation }, { headers: { "set-cookie": `${sessionCookie}; Path=/; HttpOnly` } });

    if (path === "/api/auth/oauth2/consent") {
      const callback = new URL(`${origin}/dashboard/oauth/callback`);
      callback.searchParams.set(accepted ? "code" : "error", accepted ? "k".repeat(43) : "access_denied");
      callback.searchParams.set("state", state);
      callback.searchParams.set("iss", "http://api.test/api/auth");

      return Response.json({ redirect: true, url: callback.toString() });
    }

    throw new Error(`Unexpected native OAuth request: ${path}`);
  }));
});

afterEach(() => vi.unstubAllGlobals());

const consentRequest = (body?: string) => new Request(continuation, {
  method: body === undefined ? "GET" : "POST",
  headers: { cookie: sessionCookie, origin, "content-type": "application/x-www-form-urlencoded" }, body,
});

describe("OAuth dashboard routes", () => {
  it("returns the live consent view without caching it", async () => {
    const result = await consentLoader(routeArgs(consentRequest(), {}));
    expect(result.data).toMatchObject({ clientName: "Dashboard OAuth proof", scopes: ["native-api", "offline_access"] });
    expect(new Headers(result.init?.headers).get("Cache-Control")).toBe("no-store");
  });
  it.each(["accept", "deny"] as const)("dispatches a distinct %s decision and validates the provider continuation", async decision => {
    accepted = decision === "accept";
    const response = await consentAction(routeArgs(consentRequest(`decision=${decision}`), {}));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get(accepted ? "code" : "error")).toBe(accepted ? "k".repeat(43) : "access_denied");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const request = requests.find(request => new URL(request.url).pathname === "/api/auth/oauth2/consent");
    expect(await request!.json()).toMatchObject({ accept: accepted, oauth_query: pendingQuery });
  });
  it("rejects ambiguous consent before backend dispatch", async () => {
    await expect(consentAction(routeArgs(consentRequest("decision=accept&decision=deny"), {}))).rejects.toMatchObject({ status: 400 });
    expect(requests).toEqual([]);
  });
  it("forwards opaque OAuth state through sign-in but does not trust redirectTo", async () => {
    const request = new Request(`${origin}/dashboard/login?${pendingQuery}`, {
      method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "oauth@example.invalid", password: "correct password", redirectTo: "https://untrusted.example/capture" }),
    });

    const response = await loginAction(routeArgs(request, {}));

    if (!(response instanceof Response)) throw new Error("Expected an OAuth redirect");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(continuation);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const signIn = requests.find(request => new URL(request.url).pathname === "/api/auth/sign-in/email");
    expect(await signIn!.json()).toEqual({ email: "oauth@example.invalid", password: "correct password", oauth_query: pendingQuery });
  });
  it("rejects invalid OAuth state before credential dispatch and does not cache the login page", async () => {
    const request = new Request(`${origin}/dashboard/login?sig=tampered`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "email=oauth%40example.invalid&password=secret" });
    const result = await loginAction(routeArgs(request, {}));

    if (!("data" in result)) throw new Error("Expected bounded OAuth error data");
    expect(result.init?.status).toBe(400);
    expect(new Headers(result.init?.headers).get("Cache-Control")).toBe("no-store");
    const page = await loginLoader(routeArgs(new Request(request.url), {}));
    expect(page.data).toEqual({ oauthError: true, oauth: true });
    expect(new Headers(page.init?.headers).get("Cache-Control")).toBe("no-store");
    expect(requests).toEqual([]);
  });
});
