import { UserProfileResponse } from "@vektorprogrammet/http-api";
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
  const client = createAuthenticatedClient(cookie, request);

  let profile: typeof UserProfileResponse.Type | null = null;
  try {
    const result = await client.profile.readOwnProfile({ headers: {} });
    if (result.body === undefined) throw new Error("Profile response did not include a body");
    profile = result.body;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "credential.missing" || code === "credential.invalid") {
      throw await expiredSessionRedirect(request);
    }
    if (code === "authority.denied") {
      throw new Response(null, { status: 403, headers: responseHeaders });
    }
    throw new Response(null, { status: 503, headers: responseHeaders });
  }

  if (profile !== null && !isDashboardRole(profile.role)) {
    throw new Response(null, { status: 403, headers: responseHeaders });
  }

  const summary: LandingSummary = { _tag: "Unavailable" };

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
