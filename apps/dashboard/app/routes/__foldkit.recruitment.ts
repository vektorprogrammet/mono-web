import { Match } from "effect";
import { data } from "react-router";
import {
  toRecruitmentBridgeFailure,
  type RecruitmentBridgeFailure,
} from "../foldkit/recruitment/bridge";
import { readRecruitmentBridgeOperation } from "../foldkit/recruitment/request.server";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/__foldkit.recruitment";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

const statusFor = (failure: RecruitmentBridgeFailure): number =>
  Match.value(failure._tag).pipe(
    Match.when("Unauthorized", () => 401),
    Match.when("Forbidden", () => 403),
    Match.when("NotFound", () => 404),
    Match.when("Validation", () => 422),
    Match.when("Conflict", () => 409),
    Match.when("RateLimited", () => 429),
    Match.when("Configuration", () => 503),
    Match.when("Network", () => 502),
    Match.exhaustive,
  );

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
    const decodedRequest = await readRecruitmentBridgeOperation(request);
    if (decodedRequest._tag === "Failure") {
      return data(decodedRequest.failure, {
        status: decodedRequest.status,
        headers: responseHeaders,
      });
    }
    const operation = decodedRequest.operation;
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
      case "readSchedulingBoard":
        return data(await recruitment.readSchedulingBoard(), {
          headers: responseHeaders,
        });
      case "scheduleInterview":
        return data(await recruitment.scheduleInterview(operation.command), {
          headers: responseHeaders,
        });
    }
  } catch (error) {
    const failure = toRecruitmentBridgeFailure(error);
    return data(failure, { status: statusFor(failure), headers: responseHeaders });
  }
}
