import { Predicate } from "effect";
import { makeNativeProblem } from "@vektorprogrammet/http-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { loadSessionIdentity, hasAuthenticatedSession, requireAuth, safeRedirect, signInWithEmail, signOut, SignInResult } from "./auth.server";

const transport = vi.fn<typeof fetch>();

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
    vi.stubEnv("API_URL", "http://api.test");
    transport.mockReset();
    vi.stubGlobal("fetch", transport);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fresh-reads the strict actor projection and returns the exact incoming Cookie", async () => {
    const rawCookie =
      "theme=dark; better-auth.session_token=session-value; invitation_capability=opaque";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({sessionId: "session-1", personId: "person-1", createdAt: "2030-01-01T00:00:00Z", updatedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-02T00:00:00Z", ipAddress: null, userAgent: null, current: true}, {headers: {"cache-control": "private, no-store", vary: "Origin"}}));
    transport.mockImplementation(fetchMock);

    const request = new Request("http://dashboard.test/dashboard", {
      headers: { Cookie: rawCookie },
    });

    await expect(requireAuth(request)).resolves.toBe(rawCookie);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0];
    expect(new Request(input, init).headers.get("cookie")).toBe(rawCookie);
  });

  it("reads the Better Auth session identity with the exact incoming Cookie", async () => {
    const rawCookie = "theme=dark; better-auth.session_token=session-value";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
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

    transport.mockImplementation(fetchMock);

    await expect(
      loadSessionIdentity(
        new Request("https://dashboard.example/dashboard", {
          headers: { Cookie: rawCookie },
        }),
      ),
    ).resolves.toEqual({ name: "Ada Lovelace", email: "ada@example.invalid" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/api/auth/get-session");
    expect(new Headers(init?.headers).get("Cookie")).toBe(rawCookie);
  });

  it("fails closed when Better Auth returns a malformed session identity", async () => {
    transport.mockImplementation(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ user: { id: "person-1" } })));

    const failure = await loadSessionIdentity(
      new Request("http://dashboard.test/dashboard", {
        headers: { Cookie: "better-auth.session_token=session-value" },
      }),
    ).catch((error) => error);

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
    
  });

  it.each([
    ["missing credential problem", { body: makeNativeProblem("credential.missing") }],
    ["invalid credential problem", { body: makeNativeProblem("credential.invalid") }],
  ] as const)("redirects an invalid session after a %s", async (_name, failure) => {
    transport.mockImplementation(vi.fn<typeof fetch>(async (input, init) => {
      const url = new Request(input, init).url;

      return url.endsWith("/api/session")
        ? Response.json(failure.body, {status: 401, headers: {"content-type": "application/problem+json", "cache-control": "no-store", vary: "Origin", "www-authenticate": 'VektorSession realm="native-api"'}})
        : responseWithCookies(200, ["better-auth.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
    }));

    const request = new Request("http://dashboard.test/dashboard", {
      headers: { Cookie: "better-auth.session_token=revoked" },
    });

    await expect(requireAuth(request)).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
    await expect(hasAuthenticatedSession(request)).resolves.toBe(false);
  });

  it("preserves a transport failure instead of redirecting or revoking the session", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network unavailable"));
    transport.mockImplementation(fetchMock);
    const request = new Request("http://dashboard.test/dashboard", {headers: {Cookie: "better-auth.session_token=session-value"}});
    await expect(requireAuth(request)).rejects.not.toBeInstanceOf(Response);
    await expect(hasAuthenticatedSession(request)).rejects.not.toBeInstanceOf(Response);
    expect(fetchMock.mock.calls.every(([input, init]) => new Request(input, init).method === "GET")).toBe(true);
  });

  it("posts email credentials to Better Auth and preserves every Set-Cookie value", async () => {
    const cookies = [
      "better-auth.session_token=session-value; Path=/; HttpOnly; SameSite=Lax; Secure",
      "better-auth.session_data=opaque; Path=/; Expires=Wed, 26 Aug 2026 12:00:00 GMT; Secure",
    ];

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseWithCookies(200, cookies));
    transport.mockImplementation(fetchMock);

    const request = new Request("https://dashboard.example/login", {
      method: "POST",
      headers: { Origin: "https://dashboard.example" },
    });

    const result = await signInWithEmail(request, "ada@example.com", "correct horse");

    expect(result._tag).toBe("Authenticated");

    if (!Predicate.isTagged(result, "Authenticated")) throw new Error("expected authenticated result");
    expect(result.headers.getSetCookie()).toEqual(cookies);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/api/auth/sign-in/email");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Origin")).toBe("https://dashboard.example");
    expect(await new Response(init?.body).json()).toEqual({
      email: "ada@example.com",
      password: "correct horse",
    });
  });

  it("forwards the opaque OAuth query in the credential request and returns the provider continuation", async () => {
    const query = "client_id=client&sig=opaque%2Bbytes";
    const cookies = ["better-auth.session_token=session-value; Path=/; HttpOnly; SameSite=Lax"];

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      responseWithCookies(
        200,
        cookies,
        JSON.stringify({
          redirect: true,
          url: "https://dashboard.example/dashboard/oauth/consent?next=signed",
        }),
      ),
    );

    transport.mockImplementation(fetchMock);

    const request = new Request("https://dashboard.example/dashboard/login", {
      method: "POST",
      headers: { Origin: "https://dashboard.example" },
    });

    const result = await signInWithEmail(request, "ada@example.com", "correct horse", query);

    expect(result._tag).toBe("Authenticated");

    if (!Predicate.isTagged(result, "Authenticated")) throw new Error("expected authenticated result");
    expect(result.continuation).toBe(
      "https://dashboard.example/dashboard/oauth/consent?next=signed",
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(await new Response(init?.body).json()).toEqual({
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

    transport.mockImplementation(vi.fn<typeof fetch>().mockResolvedValue(response));

    const request = new Request("https://dashboard.example/dashboard/login", {
      method: "POST",
      headers: { Origin: "https://dashboard.example" },
    });

    await expect(
      signInWithEmail(request, "ada@example.com", "correct horse", "sig=tampered"),
    ).resolves.toEqual(SignInResult.InvalidOAuthRequest());
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

    if (!(failure instanceof Response)) throw new Error("Expected an authentication redirect");
    const response = failure;
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

    transport.mockImplementation(vi.fn<typeof fetch>().mockResolvedValue(response));
    const request = new Request("http://dashboard.test/login", { method: "POST" });

    await expect(signInWithEmail(request, "invalid@example.com", "wrong")).resolves.toEqual({
      _tag: tag,
    });
    expect(response.bodyUsed).toBe(false);
  });
  it("maps an endpoint configuration failure to Unavailable without exposing its details", async () => {
    vi.stubEnv("API_URL", "");
    vi.resetModules();
    const { signInWithEmail: signInWithoutApi } = await import("./auth.server");
    const request = new Request("http://dashboard.test/login", { method: "POST" });

    await expect(signInWithoutApi(request, "ada@example.com", "wrong")).resolves.toEqual(SignInResult.Unavailable());
  });

  it("deletes the generated native session and emits local clearing cookies", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {status: 204, headers: {"cache-control": "no-store", vary: "Origin"}}));
    transport.mockImplementation(fetchMock);
    const rawCookie = "theme=dark; better-auth.session_token=session-value";

    const request = new Request("https://dashboard.example/logout", {
      method: "POST",
      headers: { Cookie: rawCookie },
    });

    const headers = await signOut(request);
    expect(headers.getSetCookie()).toEqual([
      "better-auth.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    ]);
    const [input, init] = fetchMock.mock.calls[0];
    const sent = new Request(input, init);
    expect(sent.method).toBe("DELETE");
    expect(sent.headers.get("cookie")).toBe(rawCookie);
    expect(sent.headers.get("idempotency-key")).toEqual(expect.any(String));
  });

  it("allows only same-origin relative post-login redirects", () => {
    expect(safeRedirect("/profile?tab=contact")).toBe("/profile?tab=contact");
    expect(safeRedirect("https://attacker.example")).toBe("/");
    expect(safeRedirect("//attacker.example")).toBe("/");
    expect(safeRedirect("/\\attacker.example")).toBe("/");
  });
});

it("rejects explicit legacy recovery before native sign-in in dev and production callers", async () => {
  vi.stubEnv("PASSWORD_RECOVERY_ENGINE", "legacy-symfony");
  const network = vi.fn();
  transport.mockImplementation(network);

  try {
    expect(
      await signInWithEmail(
        new Request("http://dashboard.test/login"),
        "person@example.invalid",
        "synthetic-password",
      ),
    ).toEqual(SignInResult.Unavailable());
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});
