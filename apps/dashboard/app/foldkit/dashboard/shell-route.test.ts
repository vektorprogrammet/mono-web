import {
  ConfigurationError,
  NetworkError,
  ProfileRejectionError,
  UnauthorizedError,
} from "@vektorprogrammet/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  expiredSessionRedirect: vi.fn(),
  createAuthenticatedClient: vi.fn(),
  profile: vi.fn(),
}));

vi.mock("../../lib/auth.server", () => ({
  requireAuth: mocks.requireAuth,
  expiredSessionRedirect: mocks.expiredSessionRedirect,
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
    mocks.createAuthenticatedClient.mockReturnValue({ me: { profile: mocks.profile } });
  });

  it.each(["AuthorityInactive", "NotInScope"] as const)(
    "keeps an authenticated %s actor in an honest no-profile shell",
    async (tag) => {
      mocks.profile.mockRejectedValueOnce(new ProfileRejectionError(tag));

      await expect(load()).resolves.toEqual({ user: null, isAdmin: false });
      expect(mocks.expiredSessionRedirect).not.toHaveBeenCalled();
    },
  );

  it("redirects only an unauthorized profile request as expired", async () => {
    mocks.profile.mockRejectedValueOnce(new UnauthorizedError());

    const failure = await load().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Response);
    expect(failure).toMatchObject({ status: 302 });
    expect(mocks.expiredSessionRedirect).toHaveBeenCalledOnce();
  });

  it.each([
    [new NetworkError("profile provider unavailable"), 502],
    [new ConfigurationError("profile provider misconfigured"), 503],
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
    expect(dashboardShellVisibility(null)).toEqual({
      showIdentityMenu: false,
      showOrganizationContext: false,
      mountChildRoutes: true,
    });
  });

  it("shows identity content for a canonical profile", () => {
    expect(
      dashboardShellVisibility({ name: "Ada Lovelace", email: "ada@example.invalid" }),
    ).toEqual({
      showIdentityMenu: true,
      showOrganizationContext: true,
      mountChildRoutes: true,
    });
  });
});
