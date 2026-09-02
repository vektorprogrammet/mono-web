import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  forwardSetCookieHeaders: vi.fn((source: Headers) => {
    const headers = new Headers();
    for (const value of source.getSetCookie()) headers.append("Set-Cookie", value);
    return headers;
  }),
}));
const api = vi.hoisted(() => ({
  serverApiEndpoint: vi.fn((path: string) => `http://api.test${path}`),
}));

vi.mock("./auth.server", () => auth);
vi.mock("./api.server", () => api);

import {
  guardOAuthContinuation,
  hasTrustedActionOrigin,
  inspectPendingOAuthRequest,
  loadOAuthConsent,
  submitOAuthConsent,
} from "./oauth.server";

const state = "s".repeat(43);
const challenge = "c".repeat(43);
const redirectUri = "http://127.0.0.1:5174/dashboard/oauth/callback";
const pendingQuery = (overrides: Readonly<Record<string, string>> = {}): string => {
  const values = {
    response_type: "code",
    client_id: "dashboard-public-client",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "urn:vektorprogrammet:native-api",
    scope: "native-api offline_access",
    prompt: "consent",
    exp: "2000000000",
    ba_iat: "1900000000000",
    ba_param: "client_id",
    sig: "provider-signature",
    ...overrides,
  };
  return Object.entries(values)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
};
const requestFor = (query = pendingQuery(), init: RequestInit = {}): Request =>
  new Request(`http://127.0.0.1:5174/dashboard/oauth/consent?${query}`, init);
const publicClientResponse = () =>
  Response.json({
    client_id: "dashboard-public-client",
    client_name: "Dashboard OAuth proof",
    client_kind: "DelegatedPublic",
  });

beforeEach(() => {
  auth.requireAuth.mockReset().mockResolvedValue("better-auth.session_token=session-value");
  auth.forwardSetCookieHeaders.mockClear();
  api.serverApiEndpoint.mockImplementation((path: string) => `http://api.test${path}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard OAuth server boundary", () => {
  it("keeps the provider query byte-for-byte while decoding only bounded display fields", () => {
    const query = pendingQuery();
    const inspected = inspectPendingOAuthRequest(requestFor(query));

    expect(inspected._tag).toBe("Pending");
    if (inspected._tag !== "Pending") throw new Error("expected pending OAuth request");
    expect(inspected.pending.raw).toBe(query);
    expect(inspected.pending).toMatchObject({
      clientId: "dashboard-public-client",
      redirectUri,
      redirectOrigin: "http://127.0.0.1:5174",
      state,
      codeChallenge: challenge,
      scope: "native-api offline_access",
      resource: "urn:vektorprogrammet:native-api",
    });
  });

  it.each([
    pendingQuery({ resource: "urn:wrong" }),
    `${pendingQuery()}&state=${state}`,
    `sig=x&${"a".repeat(8 * 1024)}`,
  ])("rejects malformed, duplicated, or oversized pending state", (query) => {
    expect(inspectPendingOAuthRequest(requestFor(query))).toEqual({ _tag: "Invalid" });
  });

  it("does not reinterpret ordinary login query parameters as OAuth state", () => {
    expect(
      inspectPendingOAuthRequest(
        new Request("http://127.0.0.1:5174/dashboard/login?redirectTo=%2Fdashboard"),
      ),
    ).toEqual({ _tag: "None" });
  });

  it("loads the live bounded client view with the exact cookie and first-party origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(publicClientResponse());
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadOAuthConsent(
      requestFor(pendingQuery(), {
        headers: { Cookie: "better-auth.session_token=session-value" },
      }),
    );

    expect(loaded.view).toEqual({
      clientName: "Dashboard OAuth proof",
      clientKind: "public",
      redirectOrigin: "http://127.0.0.1:5174",
      resourceName: "Vektorprogrammet native API",
      scopes: ["native-api", "offline_access"],
    });
    expect(auth.requireAuth).toHaveBeenCalledWith(expect.any(Request), `/login?${pendingQuery()}`);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "http://api.test/api/auth/oauth2/public-client?client_id=dashboard-public-client",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("Cookie")).toBe("better-auth.session_token=session-value");
    expect(headers.get("Origin")).toBe("http://127.0.0.1:5174");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("x-vektorprogrammet-request-correlation")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("submits only the accepted scope and opaque query, then guards the callback", async () => {
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "k".repeat(43));
    callback.searchParams.set("state", state);
    callback.searchParams.set("iss", "http://api.test/api/auth");
    const consentHeaders = new Headers({ "Set-Cookie": "better-auth.session_data=next; Path=/" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ redirect: true, url: callback.toString() }, { headers: consentHeaders }),
      )
      .mockResolvedValueOnce(publicClientResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitOAuthConsent(
      requestFor(pendingQuery(), {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=session-value",
          Origin: "http://127.0.0.1:5174",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "decision=accept",
      }),
      true,
    );

    expect(result.location).toBe(callback.toString());
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.getSetCookie()).toEqual(["better-auth.session_data=next; Path=/"]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      accept: true,
      scope: "native-api offline_access",
      oauth_query: pendingQuery(),
    });
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
  });

  it("sends denial without an accepted scope", async () => {
    const callback = new URL(redirectUri);
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("error_description", "User denied access");
    callback.searchParams.set("state", state);
    callback.searchParams.set("iss", "http://api.test/api/auth");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ redirect: true, url: callback.toString() }))
      .mockResolvedValueOnce(publicClientResponse());
    vi.stubGlobal("fetch", fetchMock);

    await submitOAuthConsent(
      requestFor(pendingQuery(), {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:5174" },
      }),
      false,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      accept: false,
      oauth_query: pendingQuery(),
    });
  });

  it.each([undefined, "https://untrusted.example"])(
    "rejects a missing or untrusted action origin before backend dispatch",
    async (origin) => {
      const headers = new Headers();
      if (origin !== undefined) headers.set("Origin", origin);
      const request = requestFor(pendingQuery(), { method: "POST", headers });
      expect(hasTrustedActionOrigin(request)).toBe(false);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(submitOAuthConsent(request, true)).rejects.toMatchObject({ status: 403 });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("leaves signature and expiry validation to Better Auth and conceals its rejection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "invalid_signature", raw: pendingQuery() }, { status: 400 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    let failure: unknown;
    try {
      await submitOAuthConsent(
        requestFor(pendingQuery({ sig: "tampered" }), {
          method: "POST",
          headers: { Origin: "http://127.0.0.1:5174" },
        }),
        true,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Response);
    const response = failure as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("tampered");
  });

  it("rejects a continuation with changed state after re-reading the client", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(publicClientResponse()));
    const inspected = inspectPendingOAuthRequest(requestFor());
    if (inspected._tag !== "Pending") throw new Error("expected pending OAuth request");
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "k".repeat(43));
    callback.searchParams.set("state", "x".repeat(43));
    callback.searchParams.set("iss", "http://api.test/api/auth");

    await expect(
      guardOAuthContinuation(
        requestFor(),
        inspected.pending,
        callback.toString(),
        "better-auth.session_token=session-value",
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
});
