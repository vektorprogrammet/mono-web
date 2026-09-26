import { Predicate } from "effect";
import { Schema as S } from "effect";
import { createElement } from "react";
import { data, useLoaderData } from "react-router";
import { DASHBOARD_ELEMENT, DASHBOARD_INPUT_ATTRIBUTE } from "../foldkit/dashboard/elements";
import { DashboardInput, DashboardInputJson, isDashboardRole, LandingSummary } from "../foldkit/dashboard/model";
import {
  boardFailureMessage,
  RecruitmentBoardStatus,
  recruitmentFailureFromSdk,
} from "../foldkit/recruitment/bridge";
import { type RecruitmentInput, LoadedRecruitmentInput, FailedRecruitmentInput } from "../foldkit/recruitment/model";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.sokere._index";

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

  if (!isDashboardRole(profile.role) || profile.role !== "ROLE_DEPARTMENT_ADMINISTRATOR") {
    throw new Response(null, { status: 403, headers: responseHeaders });
  }

  const rawStatus = new URL(request.url).searchParams.get("status") ?? "all";
  let status: RecruitmentBoardStatus;

  try {
    status = S.decodeUnknownSync(RecruitmentBoardStatus)(rawStatus);
  } catch {
    throw new Response("Ugyldig søkerfilter.", { status: 400, headers: responseHeaders });
  }

  let recruitment: RecruitmentInput;

  try {
    const result = await client.recruitment.readAssignmentBoard({ query: { status } });
    recruitment = LoadedRecruitmentInput.make({status,
board: result.body});
  } catch (error) {
    const failure = recruitmentFailureFromSdk(error);

    if (Predicate.isTagged(failure, "Unauthorized")) throw await expiredSessionRedirect(request);

    if (Predicate.isTagged(failure, "Forbidden")) {
      throw new Response(null, { status: 403, headers: responseHeaders });
    }

    recruitment = FailedRecruitmentInput.make({status,
message: boardFailureMessage(failure)});
  }

  const dashboardInput = S.decodeSync(DashboardInput)(
    {
      user: {
        name: `${profile.firstName} ${profile.lastName}`.trim(),
        avatar: null,
      },
      role: profile.role,
      activePath: new URL(request.url).pathname,
      summary: LandingSummary.make({}),
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

/** This route renders the complete Foldkit navigation and main landmark. */
export const handle = { dashboardShell: "owned" } as const;
