import { nativeProblemFrom } from "../../lib/native-problem";
import { callNative } from "../../lib/api.server";
import { expiredSessionRedirect, loadSessionIdentity, requireAuth } from "../../lib/auth.server";
import type { DashboardShellData } from "./shell";

export async function loadDashboardShell(request: Request): Promise<DashboardShellData> {
  const cookie = await requireAuth(request);

  try {
    const { profile } = await callNative(cookie, request, (client) =>
      client["profile.readOwnProfile"](),
    );

    return {
      user: {
        name: `${profile.firstName} ${profile.lastName}`,
        email: profile.email,
      },
      isAdmin: profile.role === "ROLE_ADMIN" || profile.role === "ROLE_DEPARTMENT_ADMINISTRATOR",
      hasOrganizationContext: true,
    };
  } catch (error) {
    const code = nativeProblemFrom(error)?.code;

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
