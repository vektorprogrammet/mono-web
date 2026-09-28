import type { NativeProblemCode } from "@vektorprogrammet/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeArgs, sessionCookie } from "../../../test/native-http";
import {
  isNativeRpcRequest,
  nativeRpcProblem,
  nativeRpcSuccess,
  nativeSession,
  readNativeRpcCall,
  type NativeRpcCall,
} from "../../../test/native-rpc";
import { RecruitmentBridgeFailure } from "./bridge";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { action } from "../../routes/__foldkit.recruitment";

let cancelAnswer: (call: NativeRpcCall) => Response = (call) =>
  nativeRpcProblem(call, "precondition.failed");

const calls: NativeRpcCall[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      if (!isNativeRpcRequest(input)) {
        throw new Error(`Unexpected recruitment request: ${new Request(input, init).url}`);
      }

      const call = await readNativeRpcCall(input, init);
      calls.push(call);

      if (call.tag === "system.readSession") return nativeRpcSuccess(call, nativeSession);

      if (call.tag === "recruitment.cancelInterview") return cancelAnswer(call);
      throw new Error(`Unexpected recruitment call: ${call.tag}`);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const cancel = () =>
  action(
    routeArgs(
      new Request("http://dashboard.test/recruitment", {
        method: "POST",
        headers: {
          origin: "http://dashboard.test",
          "content-type": "application/json",
          cookie: sessionCookie,
        },
        body: JSON.stringify({
          operation: "cancelInterview",
          params: { interviewId: "recruitment-interview-50" },
          headers: {
            "idempotency-key": "A".repeat(22),
            "if-match": `"vkr2.${"A".repeat(43)}"`,
          },
          payload: {},
        }),
      }),
      {},
    ),
  );

describe("Recruitment bridge failures across the RPC client", () => {
  it("passes the key and the tag of the browser's command to the RPC", async () => {
    cancelAnswer = (call) => nativeRpcProblem(call, "precondition.failed");
    await cancel();

    const call = calls.find((each) => each.tag === "recruitment.cancelInterview");

    expect(call?.payload).toEqual({
      interviewId: "recruitment-interview-50",
      idempotencyKey: "A".repeat(22),
      ifMatch: `"vkr2.${"A".repeat(43)}"`,
    });
    expect(call?.headers.get("cookie")).toBe(sessionCookie);
  });

  it.each<[NativeProblemCode, RecruitmentBridgeFailure["_tag"], number]>([
    ["precondition.failed", "Conflict", 409],
    ["recruitment.already-finalized", "Conflict", 409],
    ["credential.invalid", "Unauthorized", 401],
    ["authority.denied", "Forbidden", 403],
    ["recruitment.interview-not-found", "NotFound", 404],
    ["dependency.unavailable", "Network", 502],
  ])("projects the RPC problem %s as %s", async (code, tag, status) => {
    cancelAnswer = (call) => nativeRpcProblem(call, code);
    const result = await cancel();

    expect(calls.some((call) => call.tag === "recruitment.cancelInterview")).toBe(true);
    expect(result?.init?.status).toBe(status);
    expect(result?.data).toHaveProperty("_tag", tag);
  });

  it("answers a transport failure as Network", async () => {
    cancelAnswer = () => {
      throw new TypeError("fetch failed");
    };

    const result = await cancel();

    expect(result?.init?.status).toBe(502);
    expect(result?.data).toEqual(
      RecruitmentBridgeFailure.cases.Network.make({ message: "Recruitment request failed" }),
    );
  });
});
