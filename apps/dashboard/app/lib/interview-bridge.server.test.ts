import { StrongETag } from "@vektorprogrammet/http-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvitationBridgeFailureSchema, INVITATION_INTERACTION_HEADER } from "../foldkit/interview/bridge";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { conditionalReadHeaders, nativeProblemResponse } from "../../test/native-http";

const transport = vi.fn<typeof fetch>();


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

  it("rejects missing, malformed, and unknown interaction bindings before creating the SDK", async () => {
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
          throw new Error("An invalid interaction binding reached the SDK");
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

    transport.mockResolvedValue(Response.json(resource.observation, { headers: conditionalReadHeaders }));


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
    const [input, init] = transport.mock.calls[0]!;
    const nativeRequest = new Request(input, init);
    expect(nativeRequest.headers.get("X-Recruitment-Invitation-Capability")).toBe(requestedCapability);
    expect(nativeRequest.headers.get("Cookie")).toBeNull();
    expect(nativeRequest.url).not.toContain(requestedCapability);
  });

  it("returns no representation for a successful native mutation", async () => {
    const interactionId = "f".repeat(32);
    const capability = "F".repeat(43);

    transport.mockResolvedValue(new Response(null, { status: 204, headers: { "cache-control": "no-store", vary: "Origin", etag } }));


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
    const [input, init] = transport.mock.calls[0]!;
    const nativeRequest = new Request(input, init);
    expect(nativeRequest.url).toBe("http://api.test/api/recruitment/invitation-response:confirm");
    expect(nativeRequest.headers.get("idempotency-key")).toBeNull();
    expect(nativeRequest.headers.get("if-match")).toBe(etag);
    expect(await nativeRequest.json()).toEqual({});
  });

  it("projects only safe SDK problems and stable statuses", async () => {
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
      ["request.malformed", "InvitationDecodeError", 422],
      ["precondition.failed", "InvitationUnavailable", 503],
      ["dependency.unavailable", "InvitationUnavailable", 503],
    ] as const;

    for (const [code, bridgeTag, status] of cases) {
      transport.mockResolvedValueOnce(nativeProblemResponse(code));

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
