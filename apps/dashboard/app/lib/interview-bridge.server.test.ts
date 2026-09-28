import { InvitationResponseResource, StrongETag } from "@vektorprogrammet/rpc";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvitationBridgeFailureSchema, INVITATION_INTERACTION_HEADER } from "../foldkit/interview/bridge";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import {
  nativeRpcProblem,
  nativeRpcSuccess,
  readNativeRpcCall,
  type NativeRpcCall,
} from "../../test/native-rpc";

const transport = vi.fn<typeof fetch>();

/** Every RPC call that the bridge sent, in order. */
const calls: NativeRpcCall[] = [];

/** Answers every RPC call with `answer`, and records the call. */
const answerWith = (answer: (call: NativeRpcCall) => Response) =>
  transport.mockImplementation(async (input, init) => {
    const call = await readNativeRpcCall(input, init);
    calls.push(call);

    return answer(call);
  });


import {
  bridgeFailureFrom,
  createInvitationCapabilityCookie,
  createInvitationInteractionId,
  decodeOperation,
  decodeOperationRequest,
  InvitationCapabilityCookiePrefix,
  runOperation,
  statusForInvitationFailure,
} from "./interview-bridge.server";

const etag = StrongETag.make(`"vkr2.${"A".repeat(43)}"`);

afterEach(() => vi.unstubAllGlobals());

describe("server-held recruitment invitation bridge", () => {
  beforeEach(() => {
    transport.mockReset();
    calls.length = 0;
    vi.stubGlobal("fetch", transport);
  });

  it("creates distinct interaction-bound session cookies scoped to the bridge", () => {
    const firstInteractionId = "a".repeat(32);
    const secondInteractionId = "b".repeat(32);
    const firstCapability = "A".repeat(43);
    const secondCapability = "B".repeat(43);

    const firstCookie = createInvitationCapabilityCookie(
      firstInteractionId,
      firstCapability,
      "/interview",
    );

    const secondCookie = createInvitationCapabilityCookie(
      secondInteractionId,
      secondCapability,
      "/dashboard/interview",
    );

    expect(firstCookie).toContain(
      `${InvitationCapabilityCookiePrefix}${firstInteractionId}=${firstCapability}`,
    );
    expect(secondCookie).toContain(
      `${InvitationCapabilityCookiePrefix}${secondInteractionId}=${secondCapability}`,
    );
    expect(firstCookie.split("=", 1)[0]).not.toBe(secondCookie.split("=", 1)[0]);

    for (const [cookie, path] of [
      [firstCookie, "/interview"],
      [secondCookie, "/dashboard/interview"],
    ]) {
      expect(cookie).toContain(`Path=${path}`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain("Max-Age");
      expect(cookie).not.toContain("Domain=");
    }
  });

  it("mints distinct opaque interaction ids from Web Crypto", () => {
    const firstInteractionId = createInvitationInteractionId();
    const secondInteractionId = createInvitationInteractionId();

    expect(firstInteractionId).toMatch(/^[a-f0-9]{32}$/);
    expect(secondInteractionId).toMatch(/^[a-f0-9]{32}$/);
    expect(firstInteractionId).not.toBe(secondInteractionId);
  });

  it("strictly decodes only the four capability-free operations", () => {
    expect(decodeOperation({ operation: "readInvitationResponse" })).toEqual({
      operation: "readInvitationResponse",
    });
    expect(decodeOperation({ operation: "confirmInvitation", etag })).toEqual({
      operation: "confirmInvitation",
      etag,
    });
    expect(decodeOperation({ operation: "rejectInvitation", etag, message: null })).toEqual({
      operation: "rejectInvitation",
      etag,
      message: null,
    });
    expect(decodeOperation({ operation: "rejectInvitation", etag, message: "   " })).toEqual({
      operation: "rejectInvitation",
      etag,
      message: null,
    });
    expect(
      decodeOperation({
        operation: "requestNewInvitationTime",
        etag,
        message: "  Kan vi møtes torsdag?  ",
      }),
    ).toEqual({
      operation: "requestNewInvitationTime",
      etag,
      message: "Kan vi møtes torsdag?",
    });
    expect(() =>
      decodeOperation({ operation: "confirmInvitation", etag, capability: "forbidden" }),
    ).toThrow();
    expect(() =>
      decodeOperation({ operation: "rejectInvitation", etag, message: "x".repeat(2_001) }),
    ).toThrow();
    expect(() =>
      decodeOperation({
        operation: "rejectInvitation",
        etag,
        message: `Kan ikke møte ${"A".repeat(43)} takk`,
      }),
    ).toThrow();
    expect(() =>
      decodeOperation({
        operation: "requestNewInvitationTime",
        etag,
        message: `Flytt intervjuet ${"A".repeat(43)} takk`,
      }),
    ).toThrow();
  });

  it("rejects query strings, wrong media types, excess fields, and oversized bodies", async () => {
    const request = (url: string, body: string, contentType = "application/json") =>
      new Request(url, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });

    await expect(
      decodeOperationRequest(
        request(
          "http://dashboard.test/interview",
          JSON.stringify({ operation: "confirmInvitation", etag }),
        ),
      ),
    ).resolves.toEqual({ operation: "confirmInvitation", etag });
    const multibyteMessage = "€".repeat(2_000);
    await expect(
      decodeOperationRequest(
        request(
          "http://dashboard.test/interview",
          JSON.stringify({ operation: "rejectInvitation", etag, message: multibyteMessage }),
        ),
      ),
    ).resolves.toEqual({ operation: "rejectInvitation", etag, message: multibyteMessage });
    await expect(
      decodeOperationRequest(request("http://dashboard.test/interview?operation=confirm", "{}")),
    ).rejects.toHaveProperty("_tag", "InvitationDecodeError");
    await expect(
      decodeOperationRequest(request("http://dashboard.test/interview", "{}", "text/plain")),
    ).rejects.toHaveProperty("_tag", "InvitationDecodeError");
    await expect(
      decodeOperationRequest(
        request(
          "http://dashboard.test/interview",
          JSON.stringify({ operation: "confirmInvitation", etag, extra: true }),
        ),
      ),
    ).rejects.toHaveProperty("_tag", "InvitationDecodeError");
    await expect(
      decodeOperationRequest(
        request(
          "http://dashboard.test/interview",
          `{"operation":"confirmInvitation","etag":${JSON.stringify(etag)},"etag":${JSON.stringify(etag)}}`,
        ),
      ),
    ).rejects.toHaveProperty("_tag", "InvitationDecodeError");
    await expect(
      decodeOperationRequest(
        request("http://dashboard.test/interview", JSON.stringify({ value: "x".repeat(16_384) })),
      ),
    ).rejects.toHaveProperty("_tag", "InvitationDecodeError");
  });

  it("cancels an undeclared oversized request body before buffering the remainder", async () => {
    let cancelled = false;

    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(2_048)),
      cancel: () => {
        cancelled = true;
      },
    });

    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } satisfies RequestInit & { readonly duplex: "half" };

    const request = new Request("http://dashboard.test/interview", init);

    await expect(decodeOperationRequest(request)).rejects.toHaveProperty("_tag", "InvitationDecodeError");
    expect(cancelled).toBe(true);
  });

  it("rejects missing, malformed, and unknown interaction bindings before any RPC", async () => {
    const readOperation = { operation: "readInvitationResponse" } as const;
    const validUnknownInteractionId = "c".repeat(32);

    const cases = [
      [new Request("http://dashboard.test/interview"), "InvitationDecodeError", 422],
      [
        new Request("http://dashboard.test/interview", {
          headers: { [INVITATION_INTERACTION_HEADER]: "malformed" },
        }),
        "InvitationDecodeError",
        422,
      ],
      [
        new Request("http://dashboard.test/interview", {
          headers: { [INVITATION_INTERACTION_HEADER]: validUnknownInteractionId },
        }),
        "InvitationNotFound",
        404,
      ],
      [
        new Request("http://dashboard.test/interview", {
          headers: {
            [INVITATION_INTERACTION_HEADER]: validUnknownInteractionId,
            cookie: `${InvitationCapabilityCookiePrefix}${validUnknownInteractionId}=malformed`,
          },
        }),
        "InvitationNotFound",
        404,
      ],
    ] as const;

    for (const [request, expectedTag, expectedStatus] of cases) {
      const failure = await runOperation(request, readOperation).then(
        () => {
          throw new Error("An invalid interaction binding reached the backend");
        },
        bridgeFailureFrom,
      );

      expect(failure._tag).toBe(expectedTag);
      expect(statusForInvitationFailure(failure)).toBe(expectedStatus);
    }

    expect(transport).not.toHaveBeenCalled();
  });

  it("resolves only the capability cookie named by the request interaction id", async () => {
    const requestedInteractionId = "d".repeat(32);
    const unrelatedInteractionId = "e".repeat(32);
    const requestedCapability = "D".repeat(43);
    const unrelatedCapability = "E".repeat(43);

    const resource = {
      observation: {
        scheduledAt: "2031-09-20T13:30:00.000Z",
        room: "K-101",
        campus: "Gløshaugen",
        responseState: "Pending",
        responseMessage: null,
      },
      etag,
    };

    answerWith((call) =>
      nativeRpcSuccess(
        call,
        Schema.encodeSync(Schema.toCodecJson(InvitationResponseResource))(
          Schema.decodeUnknownSync(InvitationResponseResource)(resource),
        ),
      ),
    );


    const requestedCookie = createInvitationCapabilityCookie(
      requestedInteractionId,
      requestedCapability,
      "/interview",
    ).split(";", 1)[0];

    const unrelatedCookie = createInvitationCapabilityCookie(
      unrelatedInteractionId,
      unrelatedCapability,
      "/interview",
    ).split(";", 1)[0];

    const request = new Request("http://dashboard.test/interview", {
      headers: {
        [INVITATION_INTERACTION_HEADER]: requestedInteractionId,
        cookie: `${unrelatedCookie}; ${requestedCookie}`,
      },
    });

    await expect(runOperation(request, { operation: "readInvitationResponse" })).resolves.toEqual(
      resource,
    );
    const [call] = calls;
    expect(call?.tag).toBe("recruitment.readInvitationResponse");
    expect(call?.payload).toEqual({ capability: requestedCapability });
    expect(call?.headers.get("Cookie")).toBeNull();
    expect(call?.url).not.toContain(requestedCapability);
  });

  it("returns no representation for a successful native mutation", async () => {
    const interactionId = "f".repeat(32);
    const capability = "F".repeat(43);

    answerWith((call) => nativeRpcSuccess(call, { etag }));


    const cookie = createInvitationCapabilityCookie(interactionId, capability, "/interview").split(
      ";",
      1,
    )[0];

    const request = new Request("http://dashboard.test/interview", {
      headers: {
        [INVITATION_INTERACTION_HEADER]: interactionId,
        cookie,
      },
    });

    await expect(runOperation(request, { operation: "confirmInvitation", etag })).resolves.toBe(
      undefined,
    );
    const [call] = calls;
    expect(call?.tag).toBe("recruitment.confirmInvitation");
    expect(call?.payload).toEqual({ capability, ifMatch: etag });
    expect(call?.headers.get("Cookie")).toBeNull();
  });

  it("projects only safe RPC problems and stable statuses", async () => {
    const interactionId = "a".repeat(32);

    const cookie = createInvitationCapabilityCookie(interactionId, "A".repeat(43), "/interview").split(
      ";",
      1,
    )[0];

    const request = new Request("http://dashboard.test/interview", {
      headers: { [INVITATION_INTERACTION_HEADER]: interactionId, cookie },
    });

    const cases = [
      ["resource.not-found", "InvitationNotFound", 404],
      ["invitation.already-responded", "InvitationAlreadyResponded", 409],
      // The confirmation declares no request.malformed, so the RPC client refuses it as a defect.
      ["request.malformed", "InvitationUnavailable", 503],
      ["precondition.failed", "InvitationUnavailable", 503],
      ["dependency.unavailable", "InvitationUnavailable", 503],
    ] as const;

    for (const [code, bridgeTag, status] of cases) {
      answerWith((call) => nativeRpcProblem(call, code));

      const failure = await runOperation(request, { operation: "confirmInvitation", etag }).then(
        () => {
          throw new Error(`The native ${code} problem did not reject`);
        },
        bridgeFailureFrom,
      );

      expect(failure._tag).toBe(bridgeTag);
      expect(statusForInvitationFailure(failure)).toBe(status);
    }

    expect(transport).toHaveBeenCalledTimes(cases.length);

    expect(
      bridgeFailureFrom(InvitationBridgeFailureSchema.cases.InvitationUnavailable.make({
        message: "raw capability or persistence detail",
      })),
    ).toEqual(InvitationBridgeFailureSchema.cases.InvitationUnavailable.make({
      message: "Invitation response unavailable",
    }));
  });
});
