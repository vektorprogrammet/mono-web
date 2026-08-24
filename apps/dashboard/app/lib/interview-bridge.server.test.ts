import { beforeEach, describe, expect, it, vi } from "vitest";
import { INVITATION_INTERACTION_HEADER } from "../foldkit/interview/bridge";

const createServerClient = vi.hoisted(() => vi.fn());

vi.mock("./api.server", () => ({ createServerClient }));

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

describe("server-held recruitment invitation bridge", () => {
  beforeEach(() => {
    createServerClient.mockReset();
  });

  it("creates distinct interaction-bound session cookies scoped to the bridge", () => {
    const firstInteractionId = "a".repeat(32);
    const secondInteractionId = "b".repeat(32);
    const firstCapability = "A".repeat(43);
    const secondCapability = "B".repeat(43);
    const firstCookie = createInvitationCapabilityCookie(firstInteractionId, firstCapability);
    const secondCookie = createInvitationCapabilityCookie(secondInteractionId, secondCapability);

    expect(firstCookie).toContain(
      `${InvitationCapabilityCookiePrefix}${firstInteractionId}=${firstCapability}`,
    );
    expect(secondCookie).toContain(
      `${InvitationCapabilityCookiePrefix}${secondInteractionId}=${secondCapability}`,
    );
    expect(firstCookie.split("=", 1)[0]).not.toBe(secondCookie.split("=", 1)[0]);
    for (const cookie of [firstCookie, secondCookie]) {
      expect(cookie).toContain("Path=/interview");
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
    expect(decodeOperation({ operation: "confirmInvitation" })).toEqual({
      operation: "confirmInvitation",
    });
    expect(decodeOperation({ operation: "rejectInvitation", message: null })).toEqual({
      operation: "rejectInvitation",
      message: null,
    });
    expect(decodeOperation({ operation: "rejectInvitation", message: "   " })).toEqual({
      operation: "rejectInvitation",
      message: null,
    });
    expect(
      decodeOperation({
        operation: "requestNewInvitationTime",
        message: "  Kan vi møtes torsdag?  ",
      }),
    ).toEqual({
      operation: "requestNewInvitationTime",
      message: "Kan vi møtes torsdag?",
    });
    expect(() =>
      decodeOperation({ operation: "confirmInvitation", capability: "forbidden" }),
    ).toThrow();
    expect(() =>
      decodeOperation({ operation: "rejectInvitation", message: "x".repeat(2_001) }),
    ).toThrow();
    expect(() =>
      decodeOperation({
        operation: "requestNewInvitationTime",
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
        request("http://dashboard.test/interview", '{"operation":"confirmInvitation"}'),
      ),
    ).resolves.toEqual({ operation: "confirmInvitation" });
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
          '{"operation":"confirmInvitation","extra":true}',
        ),
      ),
    ).rejects.toMatchObject({ _tag: "InvitationDecodeError" });
    await expect(
      decodeOperationRequest(
        request("http://dashboard.test/interview", JSON.stringify({ value: "x".repeat(4_096) })),
      ),
    ).rejects.toMatchObject({ _tag: "InvitationDecodeError" });
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
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("resolves only the capability cookie named by the request interaction id", async () => {
    const requestedInteractionId = "d".repeat(32);
    const unrelatedInteractionId = "e".repeat(32);
    const requestedCapability = "D".repeat(43);
    const unrelatedCapability = "E".repeat(43);
    const read = vi.fn().mockResolvedValue({ responseState: "Pending" });
    createServerClient.mockReturnValue({
      recruitmentInvitationResponses: { read },
    } as never);
    const requestedCookie = createInvitationCapabilityCookie(
      requestedInteractionId,
      requestedCapability,
    ).split(";", 1)[0];
    const unrelatedCookie = createInvitationCapabilityCookie(
      unrelatedInteractionId,
      unrelatedCapability,
    ).split(";", 1)[0];
    const request = new Request("http://dashboard.test/interview", {
      headers: {
        [INVITATION_INTERACTION_HEADER]: requestedInteractionId,
        cookie: `${unrelatedCookie}; ${requestedCookie}`,
      },
    });

    await expect(runOperation(request, { operation: "readInvitationResponse" })).resolves.toEqual({
      responseState: "Pending",
    });
    expect(createServerClient).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(requestedCapability);
  });

  it("projects only safe typed SDK failures and stable statuses", () => {
    const cases = [
      ["RecruitmentInvitationNotFound", "InvitationNotFound", 404],
      ["RecruitmentInvitationAlreadyResponded", "InvitationAlreadyResponded", 409],
      ["RecruitmentDecodeError", "InvitationDecodeError", 422],
      ["RecruitmentPersistenceError", "InvitationUnavailable", 503],
    ] as const;

    for (const [recruitmentTag, bridgeTag, status] of cases) {
      const failure = bridgeFailureFrom({
        recruitmentTag,
        message: "unsafe backend detail",
      });
      expect(failure._tag).toBe(bridgeTag);
      expect(failure.message).not.toContain("unsafe");
      expect(statusForInvitationFailure(failure)).toBe(status);
    }

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
