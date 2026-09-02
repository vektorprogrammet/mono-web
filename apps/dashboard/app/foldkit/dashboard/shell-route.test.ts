import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  expiredSessionRedirect: vi.fn(),
  loadSessionIdentity: vi.fn(),
  createAuthenticatedClient: vi.fn(),
  profile: vi.fn(),
}));

vi.mock("../../lib/auth.server", () => ({
  requireAuth: mocks.requireAuth,
  expiredSessionRedirect: mocks.expiredSessionRedirect,
  loadSessionIdentity: mocks.loadSessionIdentity,
}));
vi.mock("../../lib/api.server", () => ({
  createAuthenticatedClient: mocks.createAuthenticatedClient,
}));

import { dashboardShellVisibility } from "./shell";
import { loadDashboardShell } from "./shell.server";

const load = () =>
  loadDashboardShell(
    new Request("http://dashboard.test/dashboard/skoler", {
      headers: { cookie: "better-auth.session_token=session-value" },
    }),
  );

describe("parent dashboard authority gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue("better-auth.session_token=session-value");
    mocks.expiredSessionRedirect.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "/login?expired=true" } }),
    );
    mocks.createAuthenticatedClient.mockReturnValue({
      profile: { readOwnProfile: mocks.profile },
    });
    mocks.loadSessionIdentity.mockResolvedValue({
      name: "Member Session",
      email: "member@example.invalid",
    });
  });

  it("keeps an authenticated authority-denied actor in a shell with session identity", async () => {
    mocks.profile.mockRejectedValueOnce({ code: "authority.denied" });

    await expect(load()).resolves.toEqual({
      user: { name: "Member Session", email: "member@example.invalid" },
      isAdmin: false,
      hasOrganizationContext: false,
    });
    expect(mocks.loadSessionIdentity).toHaveBeenCalledOnce();
    expect(mocks.expiredSessionRedirect).not.toHaveBeenCalled();
  });

  it("returns a canonical profile identity for an active team member", async () => {
    mocks.profile.mockResolvedValueOnce({
      body: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.invalid",
        role: "ROLE_TEAM_MEMBER",
      },
    });

    await expect(load()).resolves.toEqual({
      user: { name: "Ada Lovelace", email: "ada@example.invalid" },
      isAdmin: false,
      hasOrganizationContext: true,
    });
    expect(mocks.loadSessionIdentity).not.toHaveBeenCalled();
  });

  it("redirects only an unauthorized profile request as expired", async () => {
    mocks.profile.mockRejectedValueOnce({ code: "credential.invalid" });

    const failure = await load().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Response);
    expect(failure).toMatchObject({ status: 302 });
    expect(mocks.expiredSessionRedirect).toHaveBeenCalledOnce();
  });

  it.each([
    [{ code: "dependency.unavailable" }, 503],
    [{ code: "configuration.invalid" }, 503],
  ] as const)("surfaces profile infrastructure failure", async (failure, status) => {
    mocks.profile.mockRejectedValueOnce(failure);

    const response = await load().catch((error: unknown) => error);
    expect(response).toBeInstanceOf(Response);
    expect(response).toMatchObject({ status });
    expect(mocks.expiredSessionRedirect).not.toHaveBeenCalled();
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
