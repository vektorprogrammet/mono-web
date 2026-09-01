import { ConfigurationError, NetworkError, UnauthorizedError } from "@vektorprogrammet/sdk";
import { createAuthenticatedClient } from "../../lib/api.server";
import { expiredSessionRedirect, loadSessionIdentity, requireAuth } from "../../lib/auth.server";
import type { DashboardShellData } from "./shell";

export async function loadDashboardShell(request: Request): Promise<DashboardShellData> {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  try {
    const profile = await client.me.profile();
    return {
      user: {
        name: `${profile.firstName} ${profile.lastName}`,
        email: profile.email,
      },
      isAdmin: profile.role === "ROLE_ADMIN" || profile.role === "ROLE_TEAM_LEADER",
      hasOrganizationContext: true,
    };
  } catch (error) {
    const profileTag =
      error !== null && typeof error === "object" && "_tag" in error ? error._tag : undefined;
    if (profileTag === "AuthorityInactive" || profileTag === "NotInScope") {
      return {
        user: await loadSessionIdentity(request),
        isAdmin: false,
        hasOrganizationContext: false,
      };
    }
    if (error instanceof UnauthorizedError) throw await expiredSessionRedirect(request);
    if (error instanceof NetworkError) throw new Response(null, { status: 502 });
    if (error instanceof ConfigurationError) throw new Response(null, { status: 503 });
    throw new Response(null, { status: 503 });
  }
}
