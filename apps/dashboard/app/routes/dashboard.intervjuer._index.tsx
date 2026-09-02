import { Schema as S } from "effect";
import { createElement } from "react";
import { data, useLoaderData } from "react-router";
import { DASHBOARD_ELEMENT, DASHBOARD_INPUT_ATTRIBUTE } from "../foldkit/dashboard/elements";
import { DashboardInput, DashboardInputJson, isDashboardRole } from "../foldkit/dashboard/model";
import {
  schedulingBoardFailureMessage,
  SchedulingBoard,
  toRecruitmentBridgeFailure,
} from "../foldkit/recruitment/bridge";
import type { SchedulingInput } from "../foldkit/scheduling/model";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.intervjuer._index";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  let profile;
  try {
    const result = await client.profile.readOwnProfile({ headers: {} });
    if (result.body === undefined) throw new Error("Profile response did not include a body");
    profile = result.body;
  } catch {
    throw await expiredSessionRedirect(request);
  }

  if (!isDashboardRole(profile.role) || profile.role !== "ROLE_TEAM_LEADER") {
    throw new Response(null, { status: 403, headers: responseHeaders });
  }

  let scheduling: SchedulingInput;
  try {
    const result = await client.recruitment.readSchedulingBoard();
    scheduling = {
      _tag: "Loaded",
      board: S.decodeUnknownSync(SchedulingBoard)(result.body, {
        onExcessProperty: "error",
      }),
    };
  } catch (error) {
    const failure = toRecruitmentBridgeFailure(error);
    if (failure._tag === "Unauthorized") throw await expiredSessionRedirect(request);
    if (failure._tag === "Forbidden") {
      throw new Response(null, { status: 403, headers: responseHeaders });
    }
    scheduling = {
      _tag: "Failed",
      message: schedulingBoardFailureMessage(failure),
    };
  }

  const dashboardInput = S.decodeUnknownSync(DashboardInput)(
    {
      user: {
        name: `${profile.firstName} ${profile.lastName}`.trim(),
        avatar: null,
      },
      role: profile.role,
      activePath: new URL(request.url).pathname,
      summary: { _tag: "Unavailable" },
      recruitment: null,
      scheduling,
    },
    { onExcessProperty: "error" },
  );

  return data(
    { serializedInput: S.encodeSync(DashboardInputJson)(dashboardInput) },
    { headers: responseHeaders },
  );
}

export const headers = () => responseHeaders;

export default function SchedulingRoute() {
  const { serializedInput } = useLoaderData<typeof loader>();
  return createElement(DASHBOARD_ELEMENT, {
    [DASHBOARD_INPUT_ATTRIBUTE]: serializedInput,
  });
}
