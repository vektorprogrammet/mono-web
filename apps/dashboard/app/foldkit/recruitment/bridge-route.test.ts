import type { NativeProblemCode } from "@vektorprogrammet/http-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeProblemResponse, nativeSessionResponse, routeArgs, sessionCookie } from "../../../test/native-http";
import { RecruitmentBridgeFailure } from "./bridge";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { action } from "../../routes/__foldkit.recruitment";

const cancelPath = "/api/recruitment/interviews/recruitment-interview-50:cancel";

let cancelResponse: () => Response = () => nativeProblemResponse("precondition.failed");

const requests: Request[] = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;

    if (path === "/api/session") return nativeSessionResponse();

    if (path === cancelPath) return cancelResponse();
    throw new Error(`Unexpected recruitment request: ${path}`);
  }));
});

afterEach(() => vi.unstubAllGlobals());

const cancel = () => action(routeArgs(new Request("http://dashboard.test/recruitment", {
  method: "POST",
  headers: { origin: "http://dashboard.test", "content-type": "application/json", cookie: sessionCookie },
  body: JSON.stringify({
    operation: "cancelInterview",
    params: { interviewId: "recruitment-interview-50" },
    headers: {
      "idempotency-key": "A".repeat(22),
      "if-match": `"vkr2.${"A".repeat(43)}"`,
    },
    payload: {},
  }),
}), {}));

describe("Recruitment bridge failures across the real SDK", () => {
  it.each<[NativeProblemCode, RecruitmentBridgeFailure["_tag"], number]>([
    ["precondition.failed", "Conflict", 409],
    ["recruitment.already-finalized", "Conflict", 409],
    ["credential.invalid", "Unauthorized", 401],
    ["authority.denied", "Forbidden", 403],
    ["recruitment.interview-not-found", "NotFound", 404],
    ["request.malformed", "Validation", 422],
    ["dependency.unavailable", "Network", 502],
  ])("projects the SDK problem %s as %s", async (code, tag, status) => {
    cancelResponse = () => nativeProblemResponse(code);
    const result = await cancel();

    expect(requests.some(request => new URL(request.url).pathname === cancelPath)).toBe(true);
    expect(result.init?.status).toBe(status);
    expect(result.data).toHaveProperty("_tag", tag);
  });

  it("answers a transport failure as Network", async () => {
    cancelResponse = () => {
      throw new TypeError("fetch failed");
    };

    const result = await cancel();

    expect(result.init?.status).toBe(502);
    expect(result.data).toEqual(RecruitmentBridgeFailure.cases.Network.make({ message: "Recruitment request failed" }));
  });
});
