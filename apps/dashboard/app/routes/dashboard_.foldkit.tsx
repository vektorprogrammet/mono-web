import {
  ConfigurationError,
  NetworkError,
  ProfileRejectionError,
  UnauthorizedError,
} from "@vektorprogrammet/sdk";
import { Schema as S } from "effect";
import { createElement } from "react";
import { data, useLoaderData } from "react-router";
import { DASHBOARD_ELEMENT, DASHBOARD_INPUT_ATTRIBUTE } from "../foldkit/dashboard/elements";
import {
  DashboardInput,
  DashboardInputJson,
  isDashboardRole,
  type LandingSummary,
} from "../foldkit/dashboard/model";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import { ownerEnabled, responseHeaders } from "../lib/interview-bridge.server";
import type { Route } from "./+types/dashboard_.foldkit";

export async function loader({ request }: Route.LoaderArgs) {
  if (!ownerEnabled()) {
    throw new Response(null, { status: 404, headers: responseHeaders });
  }

  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie);

  let profile: Awaited<ReturnType<typeof client.me.profile>> | null = null;
  try {
    profile = await client.me.profile();
  } catch (error) {
    if (
      !(
        error instanceof ProfileRejectionError &&
        (error.profileTag === "AuthorityInactive" || error.profileTag === "NotInScope")
      )
    ) {
      if (error instanceof UnauthorizedError) throw await expiredSessionRedirect(request);
      if (error instanceof NetworkError) throw new Response(null, { status: 502 });
      if (error instanceof ConfigurationError) throw new Response(null, { status: 503 });
      throw new Response(null, { status: 503 });
    }
  }

  if (profile !== null && !isDashboardRole(profile.role)) {
    throw new Response(null, { status: 403, headers: responseHeaders });
  }

  let summary: LandingSummary = { _tag: "Unavailable" };
  if (profile !== null) {
    try {
      const dashboard = await client.me.dashboard();
      summary = {
        _tag: "Available",
        department: dashboard.department,
        activeAssistants: dashboard.activeAssistants,
        pendingApplications: dashboard.pendingApplications,
        upcomingInterviews: dashboard.upcomingInterviews,
      };
    } catch {
      summary = { _tag: "Unavailable" };
    }
  }

  const dashboardInput = S.decodeUnknownSync(DashboardInput)(
    {
      user:
        profile === null
          ? null
          : {
              name: `${profile.firstName} ${profile.lastName}`.trim(),
              avatar: null,
            },
      role: profile === null ? null : profile.role,
      activePath: new URL(request.url).pathname,
      summary,
      recruitment: null,
      scheduling: null,
    },
    { onExcessProperty: "error" },
  );

  return data(
    {
      serializedInput: S.encodeSync(DashboardInputJson)(dashboardInput),
    },
    { headers: responseHeaders },
  );
}

export const headers = () => responseHeaders;

export default function DashboardFoldkitRoute() {
  const { serializedInput } = useLoaderData<typeof loader>();
  return createElement(DASHBOARD_ELEMENT, {
    [DASHBOARD_INPUT_ATTRIBUTE]: serializedInput,
  });
}
