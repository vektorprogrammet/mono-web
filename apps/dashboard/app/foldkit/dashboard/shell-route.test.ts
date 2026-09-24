import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conditionalReadHeaders, nativeProblemResponse, nativeSessionResponse, sessionCookie } from "../../../test/native-http";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { dashboardShellVisibility } from "./shell";
import { loadDashboardShell } from "./shell.server";

const profile = { personId: "person-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.invalid", phone: "+47 12345678", role: "ROLE_TEAM_MEMBER", nameRevision: 0, contactRevision: 0 };

const requests: Request[] = [];

let profileResponse = () => Response.json(profile, { headers: conditionalReadHeaders });

const load = () => loadDashboardShell(new Request("http://dashboard.test/dashboard/skoler", { headers: { cookie: sessionCookie } }));

beforeEach(() => {
  requests.length = 0;
  profileResponse = () => Response.json(profile, { headers: conditionalReadHeaders });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;

    if (path === "/api/session") return nativeSessionResponse();

    if (path === "/api/auth/get-session") return Response.json({ user: { name: "Member Session", email: "member@example.invalid" } });

    if (path === "/api/auth/sign-out") return new Response(null, { status: 204 });

    return profileResponse();
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("parent dashboard authority gate", () => {
  it("keeps an authenticated authority-denied actor in a shell with session identity", async () => {
    profileResponse = () => nativeProblemResponse("authority.denied");
    await expect(load()).resolves.toEqual({ user: { name: "Member Session", email: "member@example.invalid" }, isAdmin: false, hasOrganizationContext: false });
    expect(requests.map(request => new URL(request.url).pathname)).toContain("/api/auth/get-session");
    expect(requests.some(request => new URL(request.url).pathname === "/api/auth/sign-out")).toBe(false);
  });
  it("returns a canonical profile identity for an active team member", async () => {
    await expect(load()).resolves.toEqual({ user: { name: "Ada Lovelace", email: "ada@example.invalid" }, isAdmin: false, hasOrganizationContext: true });
    expect(requests.some(request => new URL(request.url).pathname === "/api/auth/get-session")).toBe(false);
  });
  it("redirects only an unauthorized profile request as expired", async () => {
    profileResponse = () => nativeProblemResponse("credential.invalid");
    await expect(load()).rejects.toMatchObject({ status: 302 });
  });
  it("surfaces a profile infrastructure failure without dropping the session", async () => {
    profileResponse = () => nativeProblemResponse("profile.unavailable");
    await expect(load()).rejects.toMatchObject({ status: 503 });
    expect(requests.some(request => new URL(request.url).pathname === "/api/auth/sign-out")).toBe(false);
  });
});


describe("parent dashboard no-profile shell", () => {
  it("hides identity-only content and retains child route mounting", () => {
    expect(dashboardShellVisibility(null, false)).toEqual({
      showIdentityMenu: false,
      showOrganizationContext: false,
      mountChildRoutes: true,
    });
  });

  it("shows identity content for a canonical profile", () => {
    expect(
      dashboardShellVisibility({ name: "Ada Lovelace", email: "ada@example.invalid" }, true),
    ).toEqual({
      showIdentityMenu: true,
      showOrganizationContext: true,
      mountChildRoutes: true,
    });
  });

  it("keeps session identity visible without exposing organization navigation", () => {
    expect(
      dashboardShellVisibility({ name: "Member Session", email: "member@example.invalid" }, false),
    ).toEqual({
      showIdentityMenu: true,
      showOrganizationContext: false,
      mountChildRoutes: true,
    });
  });
});
