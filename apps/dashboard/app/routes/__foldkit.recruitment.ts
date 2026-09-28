import { Predicate } from "effect";
import { Match } from "effect";
import { data } from "react-router";
import { recruitmentFailureFromSdk, RecruitmentBridgeFailure } from "../foldkit/recruitment/bridge";
import { readRecruitmentBridgeOperation } from "../foldkit/recruitment/request.server";
import { callNative } from "../lib/api.server";
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
    Match.when("Network", () => 502),
    Match.exhaustive,
  );

export async function action({ request }: Route.ActionArgs) {
  let cookie: string;

  try {
    cookie = await requireAuth(request);
  } catch {
    const failure: RecruitmentBridgeFailure = RecruitmentBridgeFailure.cases.Unauthorized.make({message: "Authentication is required"});

    return data(failure, { status: 401, headers: responseHeaders });
  }

  try {
    const decodedRequest = await readRecruitmentBridgeOperation(request);

    if (Predicate.isTagged(decodedRequest, "Failure")) {
      return data(decodedRequest.failure, {
        status: decodedRequest.status,
        headers: responseHeaders,
      });
    }

    const operation = decodedRequest.operation;

    switch (operation.operation) {
      case "readAssignmentBoard":
        return data(
          await callNative(cookie, request, (client) =>
            client["recruitment.readAssignmentBoard"](operation.query),
          ),
          { headers: responseHeaders },
        );

      case "createApplicationInterview": {
        const created = await callNative(cookie, request, (client) =>
          client["recruitment.createApplicationInterview"]({
            applicationId: operation.params.applicationId,
            idempotencyKey: operation.headers["idempotency-key"],
            request: operation.payload,
          }),
        );

        return data(created.interview, { headers: responseHeaders });
      }

      case "readSchedulingBoard":
        return data(
          await callNative(cookie, request, (client) => client["recruitment.readSchedulingBoard"]()),
          { headers: responseHeaders },
        );

      case "scheduleInterview": {
        const scheduled = await callNative(cookie, request, (client) =>
          client["recruitment.scheduleInterview"]({
            interviewId: operation.params.interviewId,
            idempotencyKey: operation.headers["idempotency-key"],
            ifMatch: operation.headers["if-match"],
            request: operation.payload,
          }),
        );

        return data(scheduled.result, { headers: responseHeaders });
      }

      case "readInterviewConduct":
        return data(
          await callNative(cookie, request, (client) =>
            client["recruitment.readInterviewConduct"]({
              interviewId: operation.params.interviewId,
            }),
          ),
          { headers: responseHeaders },
        );

      case "finalizeInterview": {
        const finalized = await callNative(cookie, request, (client) =>
          client["recruitment.finalizeInterview"]({
            interviewId: operation.params.interviewId,
            idempotencyKey: operation.headers["idempotency-key"],
            ifMatch: operation.headers["if-match"],
            request: operation.payload,
          }),
        );

        return data(finalized.result, { headers: responseHeaders });
      }

      case "correctInterviewAssessment": {
        const corrected = await callNative(cookie, request, (client) =>
          client["recruitment.correctInterviewAssessment"]({
            interviewId: operation.params.interviewId,
            idempotencyKey: operation.headers["idempotency-key"],
            ifMatch: operation.headers["if-match"],
            request: operation.payload,
          }),
        );

        return data(corrected.result, { headers: responseHeaders });
      }

      case "cancelInterview": {
        const cancelled = await callNative(cookie, request, (client) =>
          client["recruitment.cancelInterview"]({
            interviewId: operation.params.interviewId,
            idempotencyKey: operation.headers["idempotency-key"],
            ifMatch: operation.headers["if-match"],
          }),
        );

        return data(cancelled.result, { headers: responseHeaders });
      }
    }
  } catch (error) {
    const failure = recruitmentFailureFromSdk(error);

    return data(failure, { status: statusFor(failure), headers: responseHeaders });
  }
}
