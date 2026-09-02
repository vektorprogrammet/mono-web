import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  const session = vi.fn();
  const deleteSession = vi.fn();
  const serverApiEndpoint = vi.fn((path: string) => `http://api.test${path}`);
  return {
    session,
    deleteSession,
    serverApiEndpoint,
    createAuthenticatedClient: vi.fn(() => ({
      system: { readSession: session, deleteSession },
    })),
  };
});

vi.mock("./api.server", () => ({
  createAuthenticatedClient: api.createAuthenticatedClient,
  serverApiEndpoint: api.serverApiEndpoint,
}));

import {
  loadSessionIdentity,
  hasAuthenticatedSession,
  requireAuth,
  safeRedirect,
  signInWithEmail,
  signOut,
} from "./auth.server";

function responseWithCookies(
  status: number,
  cookies: ReadonlyArray<string>,
  body = "body must remain opaque",
): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

describe("native dashboard authentication", () => {
  beforeEach(() => {
    api.session.mockReset();
    api.deleteSession.mockReset();
    api.serverApiEndpoint.mockImplementation((path: string) => `http://api.test${path}`);
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
    expect(api.createAuthenticatedClient).toHaveBeenCalledWith(rawCookie, request);
    expect(api.session).toHaveBeenCalledOnce();
  });

  it("reads the Better Auth session identity with the exact incoming Cookie", async () => {
    const rawCookie = "theme=dark; better-auth.session_token=session-value";
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        session: { id: "session-1" },
        user: {
          id: "person-1",
          name: "Ada Lovelace",
          email: "ada@example.invalid",
          emailVerified: true,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadSessionIdentity(
        new Request("https://dashboard.example/dashboard", {
          headers: { Cookie: rawCookie },
        }),
      ),
    ).resolves.toEqual({ name: "Ada Lovelace", email: "ada@example.invalid" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/auth/get-session");
    expect(new Headers(init.headers).get("Cookie")).toBe(rawCookie);
  });

  it("fails closed when Better Auth returns a malformed session identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ user: { id: "person-1" } })));

    const failure = await loadSessionIdentity(
      new Request("http://dashboard.test/dashboard", {
        headers: { Cookie: "better-auth.session_token=session-value" },
      }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Response);
    expect(failure).toMatchObject({ status: 502 });
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

  it.each([
    ["missing credential problem", { code: "credential.missing" }],
    ["invalid credential problem", { code: "credential.invalid" }],
  ] as const)("redirects an invalid session after a %s", async (_name, failure) => {
    api.session.mockRejectedValue(failure);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
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

  it.each([
    ["network", { code: "dependency.unavailable" }],
    ["configuration", { code: "configuration.invalid" }],
    ["server", { code: "server.unavailable" }],
    ["unknown provider", new Error("authentication provider unavailable")],
  ] as const)("preserves a %s session inspection failure", async (_name, failure) => {
    api.session.mockRejectedValue(failure);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://dashboard.test/dashboard", {
      headers: { Cookie: "better-auth.session_token=session-value" },
    });

    await expect(requireAuth(request)).rejects.toBe(failure);
    await expect(hasAuthenticatedSession(request)).rejects.toBe(failure);
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(new Headers(init.headers).get("Origin")).toBe("https://dashboard.example");
    expect(JSON.parse(String(init.body))).toEqual({
      email: "ada@example.com",
      password: "correct horse",
    });
  });

  it("forwards the opaque OAuth query in the credential request and returns the provider continuation", async () => {
    const query = "client_id=client&sig=opaque%2Bbytes";
    const cookies = ["better-auth.session_token=session-value; Path=/; HttpOnly; SameSite=Lax"];
    const fetchMock = vi.fn().mockResolvedValue(
      responseWithCookies(
        200,
        cookies,
        JSON.stringify({
          redirect: true,
          url: "https://dashboard.example/dashboard/oauth/consent?next=signed",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("https://dashboard.example/dashboard/login", {
      method: "POST",
      headers: { Origin: "https://dashboard.example" },
    });

    const result = await signInWithEmail(request, "ada@example.com", "correct horse", query);

    expect(result._tag).toBe("Authenticated");
    if (result._tag !== "Authenticated") throw new Error("expected authenticated result");
    expect(result.continuation).toBe(
      "https://dashboard.example/dashboard/oauth/consent?next=signed",
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      email: "ada@example.com",
      password: "correct horse",
      oauth_query: query,
    });
  });

  it("maps a provider signature rejection without exposing its body", async () => {
    const response = responseWithCookies(
      400,
      [],
      "sig=credential-engine-state-that-must-not-be-returned",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const request = new Request("https://dashboard.example/dashboard/login", {
      method: "POST",
      headers: { Origin: "https://dashboard.example" },
    });

    await expect(
      signInWithEmail(request, "ada@example.com", "correct horse", "sig=tampered"),
    ).resolves.toEqual({ _tag: "InvalidOAuthRequest" });
    expect(response.bodyUsed).toBe(false);
  });

  it("preserves the exact OAuth login destination for a missing session", async () => {
    const destination = "/login?client_id=client&sig=opaque%2Bbytes";
    let failure: unknown;
    try {
      await requireAuth(
        new Request("https://dashboard.example/dashboard/oauth/consent"),
        destination,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Response);
    const response = failure as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(destination);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    [401, "InvalidCredentials"],
    [429, "RateLimited"],
    [422, "Unavailable"],
    [500, "Unavailable"],
    [503, "Unavailable"],
  ] as const)("maps a %s sign-in response to a safe typed outcome", async (status, tag) => {
    const response = responseWithCookies(
      status,
      [],
      "provider-secret=do-not-return; BETTER_AUTH_SECRET=never-leak",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const request = new Request("http://dashboard.test/login", { method: "POST" });

    await expect(signInWithEmail(request, "invalid@example.com", "wrong")).resolves.toEqual({
      _tag: tag,
    });
    expect(response.bodyUsed).toBe(false);
  });
  it("maps an endpoint configuration failure to Unavailable without exposing its details", async () => {
    api.serverApiEndpoint.mockImplementation(() => {
      throw new Error("API URL missing; BETTER_AUTH_SECRET=never-leak");
    });
    const request = new Request("http://dashboard.test/login", { method: "POST" });

    await expect(signInWithEmail(request, "ada@example.com", "wrong")).resolves.toEqual({
      _tag: "Unavailable",
    });
  });

  it("deletes the generated native session and emits local clearing cookies", async () => {
    api.deleteSession.mockResolvedValue(undefined);
    const rawCookie = "theme=dark; better-auth.session_token=session-value";
    const request = new Request("https://dashboard.example/logout", {
      method: "POST",
      headers: { Cookie: rawCookie },
    });

    const headers = await signOut(request);
    expect(headers.getSetCookie()).toEqual([
      "better-auth.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    ]);
    expect(api.createAuthenticatedClient).toHaveBeenCalledWith(rawCookie, request);
    expect(api.deleteSession).toHaveBeenCalledOnce();
    expect(api.deleteSession).toHaveBeenCalledWith({
      headers: { "idempotency-key": expect.any(String) },
    });
  });

  it("allows only same-origin relative post-login redirects", () => {
    expect(safeRedirect("/profile?tab=contact")).toBe("/profile?tab=contact");
    expect(safeRedirect("https://attacker.example")).toBe("/");
    expect(safeRedirect("//attacker.example")).toBe("/");
    expect(safeRedirect("/\\attacker.example")).toBe("/");
  });
});
