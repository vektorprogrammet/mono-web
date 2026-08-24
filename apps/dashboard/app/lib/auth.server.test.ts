import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  const session = vi.fn();
  return {
    session,
    createAuthenticatedClient: vi.fn(() => ({ me: { session } })),
  };
});

vi.mock("./api.server", () => ({
  createAuthenticatedClient: api.createAuthenticatedClient,
  serverApiEndpoint: (path: string) => `http://api.test${path}`,
}));

import {
  hasAuthenticatedSession,
  requireAuth,
  safeRedirect,
  signInWithEmail,
  signOut,
} from "./auth.server";

function responseWithCookies(status: number, cookies: ReadonlyArray<string>): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response("body must remain opaque", { status, headers });
}

describe("native dashboard authentication", () => {
  beforeEach(() => {
    api.session.mockReset();
    api.createAuthenticatedClient.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fresh-reads the strict actor projection and returns the exact incoming Cookie", async () => {
    const rawCookie =
      "theme=dark; better-auth.session_token=session-value; invitation_capability=opaque";
    api.session.mockResolvedValue({ personId: "person-1" });
    const request = new Request("http://dashboard.test/dashboard", {
      headers: { Cookie: rawCookie },
    });

    await expect(requireAuth(request)).resolves.toBe(rawCookie);
    expect(api.createAuthenticatedClient).toHaveBeenCalledWith(rawCookie);
    expect(api.session).toHaveBeenCalledOnce();
  });

  it("does not treat unrelated browser cookies as authentication evidence", async () => {
    const request = new Request("http://dashboard.test/dashboard", {
      headers: { Cookie: "theme=dark; invitation_capability=opaque" },
    });

    await expect(requireAuth(request)).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
    expect(api.createAuthenticatedClient).not.toHaveBeenCalled();
  });

  it("fails closed when the strict actor projection cannot be read", async () => {
    api.session.mockRejectedValue(new Error("revoked"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseWithCookies(200, [
          "better-auth.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        ]),
      ),
    );
    const request = new Request("http://dashboard.test/dashboard", {
      headers: { Cookie: "better-auth.session_token=revoked" },
    });

    await expect(requireAuth(request)).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
    await expect(hasAuthenticatedSession(request)).resolves.toBe(false);
  });

  it("posts email credentials to Better Auth and preserves every Set-Cookie value", async () => {
    const cookies = [
      "better-auth.session_token=session-value; Path=/; HttpOnly; SameSite=Lax; Secure",
      "better-auth.session_data=opaque; Path=/; Expires=Wed, 26 Aug 2026 12:00:00 GMT; Secure",
    ];
    const fetchMock = vi.fn().mockResolvedValue(responseWithCookies(200, cookies));
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://dashboard.example/login", {
      method: "POST",
      headers: { Origin: "https://dashboard.example" },
    });

    const result = await signInWithEmail(request, "ada@example.com", "correct horse");

    expect(result._tag).toBe("Authenticated");
    if (result._tag !== "Authenticated") throw new Error("expected authenticated result");
    expect(result.headers.getSetCookie()).toEqual(cookies);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/auth/sign-in/email");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("Origin")).toBe(
      "https://dashboard.example",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      email: "ada@example.com",
      password: "correct horse",
    });
  });

  it("maps invalid Better Auth credentials without relying on the response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 401 })));
    const request = new Request("http://dashboard.test/login", { method: "POST" });

    await expect(signInWithEmail(request, "invalid@example.com", "wrong")).resolves.toEqual({
      _tag: "InvalidCredentials",
    });
  });

  it("forwards the raw Cookie to sign-out and preserves all clearing cookies", async () => {
    const cookies = [
      "better-auth.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      "better-auth.session_data=; Path=/; HttpOnly; Max-Age=0",
    ];
    const fetchMock = vi.fn().mockResolvedValue(responseWithCookies(200, cookies));
    vi.stubGlobal("fetch", fetchMock);
    const rawCookie = "theme=dark; better-auth.session_token=session-value";
    const request = new Request("https://dashboard.example/logout", {
      method: "POST",
      headers: { Cookie: rawCookie },
    });

    const headers = await signOut(request);
    expect(headers.getSetCookie()).toEqual(cookies);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/auth/sign-out");
    expect((init.headers as Headers).get("Cookie")).toBe(rawCookie);
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("Origin")).toBe(
      "https://dashboard.example",
    );
  });

  it("allows only same-origin relative post-login redirects", () => {
    expect(safeRedirect("/dashboard/profile?tab=contact")).toBe(
      "/dashboard/profile?tab=contact",
    );
    expect(safeRedirect("https://attacker.example")).toBe("/dashboard");
    expect(safeRedirect("//attacker.example")).toBe("/dashboard");
    expect(safeRedirect("/\\attacker.example")).toBe("/dashboard");
  });
});
