import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeArgs } from "../../test/native-http";
import { nativeRpcProblem, nativeRpcSuccess, readNativeRpcCall, type NativeRpcCall } from "../../test/native-rpc";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { loader } from "../routes/interview-response.$capability";

const transport = vi.fn<typeof fetch>();

const pending = { scheduledAt: "2031-09-20T13:30:00.000Z", room: "K-101", campus: "Gløshaugen", responseState: "Pending", responseMessage: null };

const etag = `"vkr2.${"A".repeat(43)}"`;

/** Every RPC call of the exchange, in order. */
const calls: NativeRpcCall[] = [];

/** Answers each later call with `answer`, and records it. */
const answerWith = (answer: (call: NativeRpcCall) => Response) =>
  transport.mockImplementation(async (input, init) => {
    const call = await readNativeRpcCall(input, init);
    calls.push(call);

    return answer(call);
  });

beforeEach(() => {
  calls.length = 0;
  transport.mockReset();
  answerWith((call) => nativeRpcSuccess(call, { observation: pending, etag }));
  vi.stubGlobal("fetch", transport);
});

afterEach(() => vi.unstubAllGlobals());

const thrownRedirect = async (capability: string, mount: "/" | "/dashboard/" = "/", trailingSlash = false): Promise<Response> => {
  try {
    await loader(routeArgs(new Request(`http://dashboard.test${mount}interview-response/${capability}${trailingSlash ? "/" : ""}`), { capability }));
  } catch (response) {
    if (response instanceof Response) return response;
    throw response;
  }

  throw new Error("Capability exchange did not redirect");
};

describe("recruitment invitation capability exchange", () => {
  it("mints distinct bindings only after validation and does not expose capabilities in redirects", async () => {
    const firstCapability = "A".repeat(43);
    const secondCapability = "B".repeat(43);
    const firstResponse = await thrownRedirect(firstCapability);
    const secondResponse = await thrownRedirect(secondCapability);
    const bindings = [];

    for (const [response, capability] of [[firstResponse, firstCapability], [secondResponse, secondCapability]] as const) {
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).not.toContain(capability);
      const url = new URL(location, "http://dashboard.test");
      expect(url.pathname).toBe("/interview-response/redacted");
      const interactionId = url.searchParams.get("interactionId");
      expect(interactionId).toMatch(/^[a-f0-9]{32}$/);
      expect(response.headers.get("set-cookie")).toContain(`recruitment_invitation_capability_${interactionId}=${capability};`);
      bindings.push(interactionId);
    }

    expect(bindings[0]).not.toBe(bindings[1]);
    expect(calls.map((call) => call.payload)).toEqual([{ capability: firstCapability }, { capability: secondCapability }]);
    expect(calls.map((call) => call.headers.get("cookie"))).toEqual([null, null]);
  });
  it("keeps the capability cookie inside the configured dashboard mount", async () => {
    const response = await thrownRedirect("C".repeat(43), "/dashboard/", true);
    expect(response.headers.get("location")).toMatch(/^\/dashboard\/interview-response\/redacted\?interactionId=[a-f0-9]{32}$/);
    expect(response.headers.get("set-cookie")).toContain("Path=/dashboard/interview");
  });
  it("does not mint or clear bindings when the real native response denies the capability", async () => {
    answerWith((call) => nativeRpcProblem(call, "resource.not-found"));
    const response = await thrownRedirect("D".repeat(43));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/interview-response/redacted");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(transport).toHaveBeenCalledOnce();
  });
  it("does not mint a binding from a malformed native observation", async () => {
    answerWith((call) => nativeRpcSuccess(call, { observation: { responseState: "Invented" }, etag }));
    const response = await thrownRedirect("E".repeat(43));
    expect(response.headers.get("location")).toBe("/interview-response/redacted");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each(["invalid", "redacted"])("does not exchange the local sentinel or malformed capability %s", async capability => {
    const response = await thrownRedirect(capability);
    expect(response.headers.get("location")).toBe("/interview-response/redacted");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
});
