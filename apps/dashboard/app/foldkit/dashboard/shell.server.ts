import { createAuthenticatedClient } from "../../lib/api.server";
import { expiredSessionRedirect, loadSessionIdentity, requireAuth } from "../../lib/auth.server";
import type { DashboardShellData } from "./shell";

export async function loadDashboardShell(request: Request): Promise<DashboardShellData> {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  try {
    const { body: profile } = await client.profile.readOwnProfile({ headers: {} });
    if (profile === undefined) throw new Error("Profile response did not include a body");
    return {
      user: {
        name: `${profile.firstName} ${profile.lastName}`,
        email: profile.email,
      },
      isAdmin: profile.role === "ROLE_ADMIN" || profile.role === "ROLE_TEAM_LEADER",
      hasOrganizationContext: true,
    };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "authority.denied") {
      return {
        user: await loadSessionIdentity(request),
        isAdmin: false,
        hasOrganizationContext: false,
      };
    }
    if (code === "credential.missing" || code === "credential.invalid") {
      throw await expiredSessionRedirect(request);
    }
    throw new Response(null, { status: 503 });
  }
}
