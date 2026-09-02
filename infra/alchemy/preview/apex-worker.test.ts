import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { BACKEND_ORIGIN, type ApexWorkerEnv } from "./apex-worker.ts";
import { APEX_IDENTITY } from "./identity.ts";

const service = (name: string) => ({
  fetch: vi.fn(async () => new Response(name, { headers: { "x-service": name } })),
});

function apexEnv(): ApexWorkerEnv {
  return {
    Homepage: service("homepage"),
    Dashboard: service("dashboard"),
    PREVIEW_STAGE: "dev-main",
    PREVIEW_HOST: "vektor.phibkro.org",
    PasswordResetEmail: {
      send: vi.fn(async () => ({ messageId: "unused-in-routing-tests" })),
    },
  };
}

const apexRequest = (path: string, init?: RequestInit) =>
  new Request(`https://vektor.phibkro.org${path}`, {
    ...init,
    headers: { host: "vektor.phibkro.org", ...init?.headers },
  });

const apiRequest = (path: string, init?: RequestInit) =>
  new Request(`https://${APEX_IDENTITY.apiHostname}${path}`, {
    ...init,
    headers: { host: APEX_IDENTITY.apiHostname, ...init?.headers },
  });

afterEach(() => vi.unstubAllGlobals());

describe("apex edge worker", () => {
  it("fetches capability routes from dashboard and public routes from homepage", async () => {
    const env = apexEnv();
    const dashboardResponse = await worker.fetch(
      apexRequest("/interview-response/accept.data"),
      env,
    );
    const homepageResponse = await worker.fetch(apexRequest("/nyheter"), env);

    expect(await dashboardResponse.text()).toBe("dashboard");
    expect(await homepageResponse.text()).toBe("homepage");
    expect(env.Dashboard.fetch).toHaveBeenCalledOnce();
    expect(env.Homepage.fetch).toHaveBeenCalledOnce();
    expect(dashboardResponse.headers.get("x-mono-web-stage")).toBe("dev-main");
  });

  it.each(["/login", "/dashboard"])(
    "forwards apex dashboard entry %s without rewriting its path",
    async (path) => {
      const env = apexEnv();

      const response = await worker.fetch(apexRequest(path), env);

      expect(await response.text()).toBe("dashboard");
      expect(env.Dashboard.fetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: `https://vektor.phibkro.org${path}` }),
      );
      expect(env.Homepage.fetch).not.toHaveBeenCalled();
    },
  );

  it("fails closed before dispatch for a mismatched stage-host pair", async () => {
    const env = { ...apexEnv(), PREVIEW_STAGE: "p20" };
    const response = await worker.fetch(apexRequest("/dashboard"), env);

    expect(response.status).toBe(503);
    expect(env.Dashboard.fetch).not.toHaveBeenCalled();
    expect(env.Homepage.fetch).not.toHaveBeenCalled();
  });

  it("accepts the restored API alias for server routing", async () => {
    let forwarded: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        forwarded = request;
        return Response.json({ status: "ok" });
      }),
    );

    const response = await worker.fetch(apiRequest("/api/health"), apexEnv());

    expect(forwarded?.url).toBe(`${BACKEND_ORIGIN}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-mono-web-stage")).toBe("dev-main");
  });

  it.each([APEX_IDENTITY.backendHostname, "p20.vektor.phibkro.org", APEX_IDENTITY.forbiddenHost])(
    "rejects unapproved edge host %s before dispatch",
    async (host) => {
      const env = apexEnv();
      const response = await worker.fetch(
        new Request("https://vektor.phibkro.org/api/health", { headers: { host } }),
        env,
      );

      expect(response.status).toBe(421);
      expect(env.Dashboard.fetch).not.toHaveBeenCalled();
      expect(env.Homepage.fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves request body and cookies while rewriting only preview-origin redirects", async () => {
    let forwarded: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        forwarded = request;
        return new Response(null, {
          status: 302,
          headers: {
            location: `${BACKEND_ORIGIN}/dashboard`,
            "set-cookie": "session=opaque; Path=/; Secure; HttpOnly; SameSite=Lax",
          },
        });
      }),
    );

    const response = await worker.fetch(
      apexRequest("/api/auth/sign-in/email?continue=1", {
        method: "POST",
        body: "credential-payload",
        headers: { cookie: "prior=session", "content-type": "text/plain" },
        duplex: "half",
      } as RequestInit),
      apexEnv(),
    );

    expect(forwarded?.url).toBe(`${BACKEND_ORIGIN}/api/auth/sign-in/email?continue=1`);
    expect(forwarded?.method).toBe("POST");
    expect(forwarded?.headers.get("cookie")).toBe("prior=session");
    expect(await forwarded?.text()).toBe("credential-payload");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://vektor.phibkro.org/dashboard");
    expect(response.headers.get("set-cookie")).toBe(
      "session=opaque; Path=/; Secure; HttpOnly; SameSite=Lax",
    );
    expect(response.headers.get("x-mono-web-stage")).toBe("dev-main");
  });

  it("keeps the email binding inactive while password recovery is backend-owned", async () => {
    let forwarded: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        forwarded = request;
        return Response.json({ code: "RESET_PASSWORD_DISABLED" }, { status: 400 });
      }),
    );
    const env = apexEnv();

    const response = await worker.fetch(
      apexRequest("/api/auth/request-password-reset", {
        method: "POST",
        body: JSON.stringify({
          email: "person@example.com",
          redirectTo: "https://vektor.phibkro.org/tilbakestill-passord",
        }),
        headers: { "content-type": "application/json" },
      }),
      env,
    );

    expect(forwarded?.url).toBe(`${BACKEND_ORIGIN}/api/auth/request-password-reset`);
    expect(response.status).toBe(400);
    expect(env.PasswordResetEmail.send).not.toHaveBeenCalled();
  });

  it.each([
    ["/dashboard?from=backend#ready", "https://vektor.phibkro.org/dashboard?from=backend#ready"],
    ["profile?from=backend", "https://vektor.phibkro.org/profile?from=backend"],
  ])("rewrites accepted relative redirect %s", async (location, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location } })),
    );

    const response = await worker.fetch(apexRequest("/api/redirect"), apexEnv());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(expected);
  });

  it.each([
    `${BACKEND_ORIGIN}@evil.example.invalid/path`,
    `${BACKEND_ORIGIN}.evil.example.invalid/path`,
    "//evil.example.invalid/path",
    `//${new URL(BACKEND_ORIGIN).host}/path`,
    "https://preview-user@origin-api.vektor.phibkro.org/path",
  ])("fails closed for hostile backend redirect %s", async (location) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: {
              location,
              "set-cookie": "session=must-not-escape; Path=/; Secure; HttpOnly",
            },
          }),
      ),
    );

    const response = await worker.fetch(apexRequest("/api/redirect"), apexEnv());

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-mono-web-stage")).toBe("dev-main");
  });
  it.each([
    ["/kontrollpanel", "/login?redirectTo=%2Fdashboard"],
    ["/kontrollpanel.data", "/login?redirectTo=%2Fdashboard"],
    ["/kontrollpanel?from=legacy", "/login?from=legacy"],
  ])("redirects legacy kontrollpanel request %s to %s", async (path, expectedLocation) => {
    const env = apexEnv();
    const response = await worker.fetch(apexRequest(path), env);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(expectedLocation);
    expect(response.headers.get("x-mono-web-stage")).toBe("dev-main");
    expect(env.Dashboard.fetch).not.toHaveBeenCalled();
    expect(env.Homepage.fetch).not.toHaveBeenCalled();
  });

  it("keeps deeper kontrollpanel paths out of the legacy redirect", async () => {
    const env = apexEnv();
    const response = await worker.fetch(apexRequest("/kontrollpanel/skoler"), env);

    expect(await response.text()).toBe("homepage");
    expect(env.Homepage.fetch).toHaveBeenCalledOnce();
  });
});
