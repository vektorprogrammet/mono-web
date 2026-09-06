import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { action as requestPasswordReset } from "../app/routes/glemt-passord";
import { action as setPassword } from "../app/routes/tilbakestill-passord";
import { action as legacySetPassword } from "../app/routes/tilbakestill-passord.$code";

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
  beforeEach(() => {
    vi.stubEnv("PASSWORD_RECOVERY_ENGINE", "native");
    vi.stubEnv("OAUTH_DASHBOARD_ORIGIN", dashboardOrigin);
    vi.stubEnv("API_URL", backendOrigin);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json({ status: true }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requests the credential engine with a fixed callback, independent of account existence", async () => {
    for (const email of ["known@example.invalid", "unknown@example.invalid"]) {
      expect(
        await requestPasswordReset({
          request: formRequest("/glemt-passord", { email }),
          params: {},
        } as never),
      ).toEqual({ success: true, error: null });
      const [url, init] = fetchMock.mock.calls.at(-1)!;
      expect(String(url)).toBe(backendOrigin + "/api/auth/request-password-reset");
      expect(JSON.parse(String(init?.body))).toEqual({
        email,
        redirectTo: dashboardOrigin + "/tilbakestill-passord",
      });
    }
  });

  it("rejects an empty email before crossing the credential boundary", async () => {
    const result = await requestPasswordReset({
      request: formRequest("/glemt-passord", { email: "" }),
      params: {},
    } as never);
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts the token only in the reset JSON body and redirects on confirmed success", async () => {
    const result = await setPassword({
      request: formRequest("/tilbakestill-passord", resetFields),
      params: {},
    } as never);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toBe("/login?reset=true");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(backendOrigin + "/api/auth/reset-password");
    expect(JSON.parse(String(init?.body))).toEqual({
      token: resetFields.token,
      newPassword: resetFields.password,
    });
  });

  it("preserves an unknown credential outcome after a server failure", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ code: "RECOVERY_UNAVAILABLE" }, { status: 503 }),
    );
    const result = await setPassword({
      request: formRequest("/tilbakestill-passord", resetFields),
      params: {},
    } as never);
    expect(result).toMatchObject({ data: { state: "OutcomeUnknown" } });
  });

  it("does not call Symfony for a legacy link in the native cohort", async () => {
    const result = await legacySetPassword({
      request: formRequest("/tilbakestill-passord/code", resetFields),
      params: { code: "code" },
    } as never);
    expect(result).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
