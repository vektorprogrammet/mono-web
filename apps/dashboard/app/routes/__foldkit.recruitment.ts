import { Schema as S } from "effect";
import { data } from "react-router";
import {
  RecruitmentBridgeOperation,
  toRecruitmentBridgeFailure,
  type RecruitmentBridgeFailure,
} from "../foldkit/recruitment/bridge";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/__foldkit.recruitment";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

const statusFor = (failure: RecruitmentBridgeFailure): number => {
  switch (failure._tag) {
    case "Unauthorized":
      return 401;
    case "Forbidden":
      return 403;
    case "NotFound":
      return 404;
    case "Validation":
      return 422;
    case "Conflict":
      return 409;
    case "RateLimited":
      return 429;
    case "Configuration":
      return 503;
    case "Network":
      return 502;
  }
};

export async function action({ request }: Route.ActionArgs) {
  let token: string;
  try {
    token = requireAuth(request);
  } catch {
    const failure: RecruitmentBridgeFailure = {
      _tag: "Unauthorized",
      message: "Authentication is required",
    };
    return data(failure, { status: 401, headers: responseHeaders });
  }

  try {

    const operation = S.decodeUnknownSync(RecruitmentBridgeOperation)(await request.json(), {
      onExcessProperty: "error",
    });
    const recruitment = createAuthenticatedClient(token).admin.recruitment;

    switch (operation.operation) {
      case "readAssignmentBoard":
        return data(await recruitment.readAssignmentBoard(operation.query), {
          headers: responseHeaders,
        });
      case "assignApplicant":
        return data(await recruitment.assignApplicant(operation.command), {
          headers: responseHeaders,
        });
    }
  } catch (error) {
    const failure = toRecruitmentBridgeFailure(error);
    return data(failure, { status: statusFor(failure), headers: responseHeaders });
  }
}
