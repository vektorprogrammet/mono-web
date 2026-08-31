import { Schema as S } from "effect";
import { createElement } from "react";
import { data, useLoaderData } from "react-router";
import { DASHBOARD_ELEMENT, DASHBOARD_INPUT_ATTRIBUTE } from "../foldkit/dashboard/elements";
import { DashboardInput, DashboardInputJson, isDashboardRole } from "../foldkit/dashboard/model";
import {
  boardFailureMessage,
  RecruitmentBoardStatus,
  toRecruitmentBridgeFailure,
} from "../foldkit/recruitment/bridge";
import type { RecruitmentInput } from "../foldkit/recruitment/model";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.sokere._index";

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

  if (!isDashboardRole(profile.role) || profile.role !== "ROLE_TEAM_LEADER") {
    throw new Response(null, { status: 403, headers: responseHeaders });
  }

  const rawStatus = new URL(request.url).searchParams.get("status") ?? "all";
  let status: typeof RecruitmentBoardStatus.Type;
  try {
    status = S.decodeUnknownSync(RecruitmentBoardStatus)(rawStatus);
  } catch {
    throw new Response("Ugyldig søkerfilter.", { status: 400, headers: responseHeaders });
  }

  let recruitment: RecruitmentInput;
  try {
    const board = await client.admin.recruitment.readAssignmentBoard({ status });
    recruitment = { _tag: "Loaded", status, board };
  } catch (error) {
    const failure = toRecruitmentBridgeFailure(error);
    if (failure._tag === "Unauthorized") throw await expiredSessionRedirect(request);
    if (failure._tag === "Forbidden") {
      throw new Response(null, { status: 403, headers: responseHeaders });
    }
    recruitment = { _tag: "Failed", status, message: boardFailureMessage(failure) };
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
      recruitment,
      scheduling: null,
    },
    { onExcessProperty: "error" },
  );

  return data(
    { serializedInput: S.encodeSync(DashboardInputJson)(dashboardInput) },
    { headers: responseHeaders },
  );
}

export const headers = () => responseHeaders;

export default function RecruitmentRoute() {
  const { serializedInput } = useLoaderData<typeof loader>();
  return createElement(DASHBOARD_ELEMENT, {
    [DASHBOARD_INPUT_ATTRIBUTE]: serializedInput,
  });
}
