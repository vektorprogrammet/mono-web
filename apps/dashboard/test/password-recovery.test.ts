import { routeArgs } from "./native-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let requestPasswordReset: typeof import("../app/routes/glemt-passord").action;

let setPassword: typeof import("../app/routes/tilbakestill-passord").action;

let legacySetPassword: typeof import("../app/routes/tilbakestill-passord.$code").action;

const dashboardOrigin = "http://127.0.0.1:5174";

const backendOrigin = "http://127.0.0.1:8790";

const fetchMock = vi.fn<typeof fetch>();

const formRequest = (path: string, fields: Readonly<Record<string, string>>) =>
  new Request(dashboardOrigin + path, {
    method: "POST",
    headers: { origin: dashboardOrigin },
    body: new URLSearchParams(fields),
  });

const resetFields = {
  token: "synthetic-reset-token",
  password: "Synthetic-New-Password",
  confirmation: "Synthetic-New-Password",
};

describe("native credential recovery route boundary", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("PASSWORD_RECOVERY_ENGINE", "native");
    vi.stubEnv("OAUTH_DASHBOARD_ORIGIN", dashboardOrigin);
    vi.stubEnv("API_URL", backendOrigin);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json({ status: true }));
    // The server URL is captured at module startup, after configuration is supplied.
    requestPasswordReset = (await import("../app/routes/glemt-passord")).action;
    setPassword = (await import("../app/routes/tilbakestill-passord")).action;
    legacySetPassword = (await import("../app/routes/tilbakestill-passord.$code")).action;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requests the credential engine with a fixed callback, independent of account existence", async () => {
    for (const email of ["known@example.invalid", "unknown@example.invalid"]) {
      expect(
        await requestPasswordReset(routeArgs(formRequest("/glemt-passord", { email }), {})),
      ).toEqual({ success: true, error: null });
      const [url, init] = fetchMock.mock.calls.at(-1)!;
      expect(new Request(url).url).toBe(backendOrigin + "/api/auth/request-password-reset");
      expect(await new Response(init?.body).json()).toEqual({
        email,
        redirectTo: dashboardOrigin + "/tilbakestill-passord",
      });
    }
  });

  it("rejects an empty email before crossing the credential boundary", async () => {
    const result = await requestPasswordReset(routeArgs(formRequest("/glemt-passord", { email: "" }), {}));

    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts the token only in the reset JSON body and redirects on confirmed success", async () => {
    const result = await setPassword(routeArgs(formRequest("/tilbakestill-passord", resetFields), {}));

    expect(result).toBeInstanceOf(Response);

    if (!(result instanceof Response)) throw new Error("Expected password recovery redirect");
    expect(result.headers.get("location")).toBe("/login?reset=true");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new Request(url).url).toBe(backendOrigin + "/api/auth/reset-password");
    expect(await new Response(init?.body).json()).toEqual({
      token: resetFields.token,
      newPassword: resetFields.password,
    });
  });

  it("preserves an unknown credential outcome after a server failure", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ code: "RECOVERY_UNAVAILABLE" }, { status: 503 }),
    );

    const result = await setPassword(routeArgs(formRequest("/tilbakestill-passord", resetFields), {}));

    expect(result).toMatchObject({ data: { state: "OutcomeUnknown" } });
  });

  it("does not call Symfony for a legacy link in the native cohort", async () => {
    const result = await legacySetPassword(routeArgs(formRequest("/tilbakestill-passord/code", resetFields), { code: "code" }));

    expect(result).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
