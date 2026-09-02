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
  let cookie: string;
  try {
    cookie = await requireAuth(request);
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
    const recruitment = createAuthenticatedClient(cookie, request).recruitment;

    switch (operation.operation) {
      case "readAssignmentBoard": {
        const result = await recruitment.readAssignmentBoard({ query: operation.query });
        return data(result.body, { headers: responseHeaders });
      }
      case "createApplicationInterview": {
        const result = await recruitment.createApplicationInterview({
          params: operation.params,
          headers: operation.headers,
          payload: operation.payload,
        });
        return data(result.body, { headers: responseHeaders });
      }
      case "readSchedulingBoard": {
        const result = await recruitment.readSchedulingBoard();
        return data(result.body, { headers: responseHeaders });
      }
      case "scheduleInterview": {
        const result = await recruitment.scheduleInterview({
          params: operation.params,
          headers: operation.headers,
          payload: operation.payload,
        });
        return data(result.body, { headers: responseHeaders });
      }
      case "readInterviewConduct": {
        const result = await recruitment.readInterviewConduct({
          params: operation.params,
          headers: operation.headers,
        });
        if (result.body === undefined) {
          throw new Error("Interview conduct response did not include a body");
        }
        return data(
          { detail: result.body, etag: result.headers.ETag },
          { headers: responseHeaders },
        );
      }
      case "finalizeInterview": {
        const result = await recruitment.finalizeInterview({
          params: operation.params,
          headers: operation.headers,
          payload: operation.payload,
        });
        return data(result.body, { headers: responseHeaders });
      }
      case "cancelInterview": {
        const result = await recruitment.cancelInterview({
          params: operation.params,
          headers: operation.headers,
          payload: operation.payload,
        });
        return data(result.body, { headers: responseHeaders });
      }
    }
  } catch (error) {
    const failure = toRecruitmentBridgeFailure(error);
    return data(failure, { status: statusFor(failure), headers: responseHeaders });
  }
}
