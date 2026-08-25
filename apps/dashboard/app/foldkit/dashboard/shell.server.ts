import {
  ConfigurationError,
  NetworkError,
  ProfileRejectionError,
  UnauthorizedError,
} from "@vektorprogrammet/sdk";
import { createAuthenticatedClient } from "../../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../../lib/auth.server";
import type { DashboardShellData } from "./shell";

export async function loadDashboardShell(request: Request): Promise<DashboardShellData> {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie);

  try {
    const profile = await client.me.profile();
    return {
      user: {
        name: `${profile.firstName} ${profile.lastName}`,
        email: profile.email,
      },
      isAdmin: profile.role === "ROLE_ADMIN" || profile.role === "ROLE_TEAM_LEADER",
    };
  } catch (error) {
    if (
      error instanceof ProfileRejectionError &&
      (error.profileTag === "AuthorityInactive" || error.profileTag === "NotInScope")
    ) {
      return { user: null, isAdmin: false };
    }
    if (error instanceof UnauthorizedError) throw await expiredSessionRedirect(request);
    if (error instanceof NetworkError) throw new Response(null, { status: 502 });
    if (error instanceof ConfigurationError) throw new Response(null, { status: 503 });
    throw new Response(null, { status: 503 });
  }
}
