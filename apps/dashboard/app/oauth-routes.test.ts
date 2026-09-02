import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  hasAuthenticatedSession: vi.fn(),
  safeRedirect: vi.fn(() => "/"),
  signInWithEmail: vi.fn(),
}));
const oauth = vi.hoisted(() => ({
  guardOAuthContinuation: vi.fn(),
  hasTrustedActionOrigin: vi.fn(),
  inspectPendingOAuthRequest: vi.fn(),
  loadOAuthConsent: vi.fn(),
  oauthNoStoreHeaders: vi.fn((source?: Headers) => {
    const headers = new Headers(source);
    headers.set("Cache-Control", "no-store");
    return headers;
  }),
  sessionCookieFromResponse: vi.fn(),
  submitOAuthConsent: vi.fn(),
}));

vi.mock("./lib/auth.server", () => auth);
vi.mock("./lib/oauth.server", () => oauth);

import { action as loginAction, loader as loginLoader } from "./routes/login";
import { action as consentAction, loader as consentLoader } from "./routes/oauth.consent";

const pending = {
  raw: "client_id=client&sig=opaque",
  clientId: "client",
  redirectUri: "http://127.0.0.1:5174/dashboard/oauth/callback",
  redirectOrigin: "http://127.0.0.1:5174",
  state: "s".repeat(43),
  codeChallenge: "c".repeat(43),
  scope: "native-api offline_access" as const,
  resource: "urn:vektorprogrammet:native-api" as const,
};
const args = (request: Request) => ({ request, params: {}, context: {} }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  auth.hasAuthenticatedSession.mockResolvedValue(false);
  oauth.hasTrustedActionOrigin.mockReturnValue(true);
  oauth.inspectPendingOAuthRequest.mockReturnValue({ _tag: "Pending", pending });
  oauth.sessionCookieFromResponse.mockReturnValue("better-auth.session_token=session-value");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth dashboard routes", () => {
  it("returns a no-store consent view from the live loader", async () => {
    oauth.loadOAuthConsent.mockResolvedValue({
      pending,
      view: {
        clientName: "Dashboard OAuth proof",
        clientKind: "public",
        redirectOrigin: "http://127.0.0.1:5174",
        resourceName: "Vektorprogrammet native API",
        scopes: ["native-api", "offline_access"],
      },
    });

    const result = await consentLoader(
      args(new Request("http://127.0.0.1:5174/dashboard/oauth/consent?opaque")),
    );

    expect(result.data).toMatchObject({ clientName: "Dashboard OAuth proof" });
    expect(new Headers(result.init?.headers).get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["accept", true],
    ["deny", false],
  ] as const)("dispatches the separate %s action", async (decision, accepted) => {
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    oauth.submitOAuthConsent.mockResolvedValue({
      location: "http://127.0.0.1:5174/dashboard/oauth/callback?code=bounded",
      headers: responseHeaders,
    });
    const request = new Request(
      "http://127.0.0.1:5174/dashboard/oauth/consent?client_id=client&sig=opaque",
      {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:5174",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ decision }),
      },
    );

    const response = await consentAction(args(request));

    expect(oauth.submitOAuthConsent).toHaveBeenCalledWith(request, accepted);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/dashboard/oauth/callback?code=bounded");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects an ambiguous consent decision", async () => {
    const request = new Request("http://127.0.0.1:5174/dashboard/oauth/consent?opaque", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "decision=accept&decision=deny",
    });

    await expect(consentAction(args(request))).rejects.toMatchObject({ status: 400 });
    expect(oauth.submitOAuthConsent).not.toHaveBeenCalled();
  });

  it("forwards only opaque OAuth state through sign-in and ignores redirectTo", async () => {
    const responseHeaders = new Headers({
      "Set-Cookie": "better-auth.session_token=session-value; Path=/; HttpOnly",
    });
    auth.signInWithEmail.mockResolvedValue({
      _tag: "Authenticated",
      headers: responseHeaders,
      continuation: "http://127.0.0.1:5174/dashboard/oauth/consent?provider=signed",
    });
    oauth.guardOAuthContinuation.mockResolvedValue(
      "http://127.0.0.1:5174/dashboard/oauth/consent?provider=signed",
    );
    const request = new Request(
      "http://127.0.0.1:5174/dashboard/login?client_id=client&sig=opaque",
      {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:5174",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email: "oauth@example.invalid",
          password: "correct password",
          redirectTo: "https://untrusted.example/capture",
        }),
      },
    );

    const response = await loginAction(args(request));
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("expected redirect response");

    expect(auth.signInWithEmail).toHaveBeenCalledWith(
      request,
      "oauth@example.invalid",
      "correct password",
      pending.raw,
    );
    expect(auth.safeRedirect).not.toHaveBeenCalled();
    expect(oauth.guardOAuthContinuation).toHaveBeenCalledWith(
      request,
      pending,
      "http://127.0.0.1:5174/dashboard/oauth/consent?provider=signed",
      "better-auth.session_token=session-value",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/dashboard/oauth/consent");
    expect(response.headers.get("Location")).not.toContain("untrusted.example");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects invalid OAuth state before credential dispatch", async () => {
    oauth.inspectPendingOAuthRequest.mockReturnValue({ _tag: "Invalid" });
    const request = new Request("http://127.0.0.1:5174/dashboard/login?sig=tampered", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:5174",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ email: "oauth@example.invalid", password: "password" }),
    });

    const result = await loginAction(args(request));
    if (!("data" in result)) throw new Error("expected bounded OAuth error data");

    expect(result.data).toMatchObject({ error: expect.stringContaining("ugyldig") });
    expect(result.init?.status).toBe(400);
    expect(new Headers(result.init?.headers).get("Cache-Control")).toBe("no-store");
    expect(auth.signInWithEmail).not.toHaveBeenCalled();
  });

  it("marks an invalid OAuth login page no-store", async () => {
    oauth.inspectPendingOAuthRequest.mockReturnValue({ _tag: "Invalid" });

    const result = await loginLoader(
      args(new Request("http://127.0.0.1:5174/dashboard/login?sig=tampered")),
    );

    expect(result.data).toEqual({ oauthError: true, oauth: true });
    expect(result.init?.status).toBe(400);
    expect(new Headers(result.init?.headers).get("Cache-Control")).toBe("no-store");
  });
});
