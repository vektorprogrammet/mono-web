import { makeNativeProblem, StrongETag } from "@vektorprogrammet/http-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INVITATION_INTERACTION_HEADER } from "../foldkit/interview/bridge";

const createConfiguredPromiseClient = vi.hoisted(() => vi.fn());

vi.mock("@vektorprogrammet/sdk", () => ({ createConfiguredPromiseClient }));

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

describe("server-held recruitment invitation bridge", () => {
  beforeEach(() => {
    createConfiguredPromiseClient.mockReset();
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
    await expect(
      decodeOperationRequest(request("http://dashboard.test/interview?operation=confirm", "{}")),
    ).rejects.toMatchObject({ _tag: "InvitationDecodeError" });
    await expect(
      decodeOperationRequest(request("http://dashboard.test/interview", "{}", "text/plain")),
    ).rejects.toMatchObject({ _tag: "InvitationDecodeError" });
    await expect(
      decodeOperationRequest(
        request(
          "http://dashboard.test/interview",
          JSON.stringify({ operation: "confirmInvitation", etag, extra: true }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "InvitationDecodeError" });
    await expect(
      decodeOperationRequest(
        request(
          "http://dashboard.test/interview",
          `{"operation":"confirmInvitation","etag":${JSON.stringify(etag)},"etag":${JSON.stringify(etag)}}`,
        ),
      ),
    ).rejects.toMatchObject({ _tag: "InvitationDecodeError" });
    await expect(
      decodeOperationRequest(
        request("http://dashboard.test/interview", JSON.stringify({ value: "x".repeat(4_096) })),
      ),
    ).rejects.toMatchObject({ _tag: "InvitationDecodeError" });
  });

  it("cancels an undeclared oversized request body before buffering the remainder", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(2_048)),
      cancel: () => {
        cancelled = true;
      },
    });
    const request = new Request("http://dashboard.test/interview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { readonly duplex: "half" });

    await expect(decodeOperationRequest(request)).rejects.toMatchObject({
      _tag: "InvitationDecodeError",
    });
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
        (error: unknown) => bridgeFailureFrom(error),
      );
      expect(failure._tag).toBe(expectedTag);
      expect(statusForInvitationFailure(failure)).toBe(expectedStatus);
    }
    expect(createConfiguredPromiseClient).not.toHaveBeenCalled();
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
    const read = vi.fn().mockResolvedValue({
      body: resource.observation,
      headers: { etag },
    });
    createConfiguredPromiseClient.mockReturnValue({
      recruitment: { readInvitationResponse: read },
    } as never);
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
    expect(createConfiguredPromiseClient).toHaveBeenCalledWith({
      headers: { "X-Recruitment-Invitation-Capability": requestedCapability },
    });
    expect(read).toHaveBeenCalledWith({ headers: {} });
  });

  it("returns no representation for a successful native mutation", async () => {
    const interactionId = "f".repeat(32);
    const capability = "F".repeat(43);
    const confirmInvitation = vi.fn().mockResolvedValue({
      body: undefined,
      headers: { etag },
    });
    createConfiguredPromiseClient.mockReturnValue({
      recruitment: { confirmInvitation },
    } as never);
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
    expect(confirmInvitation).toHaveBeenCalledWith({
      headers: {
        "idempotency-key": expect.stringMatching(/^[a-f0-9]{64}$/),
        "if-match": etag,
      },
      payload: {},
    });
  });

  it("projects only safe current problem codes and stable statuses", () => {
    const cases = [
      ["resource.not-found", "InvitationNotFound", 404],
      ["invitation.already-responded", "InvitationAlreadyResponded", 409],
      ["validation.failed", "InvitationDecodeError", 422],
      ["idempotency.unavailable", "InvitationUnavailable", 503],
    ] as const;

    for (const [code, bridgeTag, status] of cases) {
      const failure = bridgeFailureFrom(
        makeNativeProblem(code, status, "urn:uuid:00000000-0000-4000-8000-000000000001"),
      );
      expect(failure._tag).toBe(bridgeTag);
      expect(failure.message).not.toContain("unsafe");
      expect(statusForInvitationFailure(failure)).toBe(status);
    }

    const infrastructureConflict = bridgeFailureFrom(
      makeNativeProblem(
        "transaction.conflict",
        409,
        "urn:uuid:00000000-0000-4000-8000-000000000002",
      ),
    );
    expect(infrastructureConflict._tag).toBe("InvitationUnavailable");
    expect(statusForInvitationFailure(infrastructureConflict)).toBe(503);

    expect(
      bridgeFailureFrom({
        _tag: "InvitationUnavailable",
        message: "raw capability or persistence detail",
      }),
    ).toEqual({
      _tag: "InvitationUnavailable",
      message: "Invitation response unavailable",
    });
  });
});
