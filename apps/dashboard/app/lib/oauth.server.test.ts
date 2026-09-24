import { Predicate } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { nativeSessionResponse, sessionCookie } from "../../test/native-http";

const stubOAuthFetch = (next: typeof fetch) => {
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);

    return new URL(request.url).pathname === "/api/session" ? nativeSessionResponse() : next(input, init);
  };

  vi.stubGlobal("fetch", transport);
};


import { guardOAuthContinuation, hasTrustedActionOrigin, inspectPendingOAuthRequest, loadOAuthConsent, submitOAuthConsent, PendingOAuthInspection } from "./oauth.server";

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
  new Request(`http://127.0.0.1:5174/dashboard/oauth/consent?${query}`, { ...init, headers: { cookie: sessionCookie, ...Object.fromEntries(new Headers(init.headers)) } });

const publicClientResponse = () =>
  Response.json({
    client_id: "dashboard-public-client",
    client_name: "Dashboard OAuth proof",
    client_kind: "DelegatedPublic",
  });



afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard OAuth server boundary", () => {
  it("keeps the provider query byte-for-byte while decoding only bounded display fields", () => {
    const query = pendingQuery();
    const inspected = inspectPendingOAuthRequest(requestFor(query));

    expect(inspected._tag).toBe("Pending");

    if (!Predicate.isTagged(inspected, "Pending")) throw new Error("expected pending OAuth request");
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
    expect(inspectPendingOAuthRequest(requestFor(query))).toEqual(PendingOAuthInspection.Invalid());
  });

  it("does not reinterpret ordinary login query parameters as OAuth state", () => {
    expect(
      inspectPendingOAuthRequest(
        new Request("http://127.0.0.1:5174/dashboard/login?redirectTo=%2Fdashboard"),
      ),
    ).toEqual(PendingOAuthInspection.None());
  });

  it("loads the live bounded client view with the exact cookie and first-party origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(publicClientResponse());
    stubOAuthFetch(fetchMock);

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

    const [url, init] = fetchMock.mock.calls[0]!;
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

    stubOAuthFetch(fetchMock);

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
    const [, init] = fetchMock.mock.calls[0]!;
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

    stubOAuthFetch(fetchMock);

    await submitOAuthConsent(
      requestFor(pendingQuery(), {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:5174" },
      }),
      false,
    );

    const [, init] = fetchMock.mock.calls[0]!;
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
      stubOAuthFetch(fetchMock);

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

    stubOAuthFetch(fetchMock);

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

    if (!(failure instanceof Response)) throw new Error("Expected OAuth rejection response");
    const response = failure;
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("tampered");
  });

  it("rejects a continuation with changed state after re-reading the client", async () => {
    stubOAuthFetch(vi.fn<typeof fetch>().mockResolvedValue(publicClientResponse()));
    const inspected = inspectPendingOAuthRequest(requestFor());

    if (!Predicate.isTagged(inspected, "Pending")) throw new Error("expected pending OAuth request");
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
