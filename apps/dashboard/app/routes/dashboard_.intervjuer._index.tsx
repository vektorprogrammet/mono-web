import { Schema as S } from "effect";
import { createElement } from "react";
import { data, useLoaderData } from "react-router";
import { DASHBOARD_ELEMENT, DASHBOARD_INPUT_ATTRIBUTE } from "../foldkit/dashboard/elements";
import { DashboardInput, DashboardInputJson, isDashboardRole } from "../foldkit/dashboard/model";
import {
  schedulingBoardFailureMessage,
  toRecruitmentBridgeFailure,
} from "../foldkit/recruitment/bridge";
import type { SchedulingInput } from "../foldkit/scheduling/model";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard_.intervjuer._index";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie);

  let profile;
  try {
    profile = await client.me.profile();
  } catch {
    throw await expiredSessionRedirect(request);
  }

  if (!isDashboardRole(profile.role)) {
    throw new Response(null, { status: 403, headers: responseHeaders });
  }

  let scheduling: SchedulingInput;
  try {
    scheduling = {
      _tag: "Loaded",
      board: await client.admin.recruitment.readSchedulingBoard(),
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
