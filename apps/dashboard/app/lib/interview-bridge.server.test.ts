import { describe, expect, it } from "vitest";
import {
  bridgeFailureFrom,
  clearInvitationCapabilityCookie,
  createInvitationCapabilityCookie,
  decodeOperation,
  decodeOperationRequest,
  statusForInvitationFailure,
} from "./interview-bridge.server";

describe("server-held recruitment invitation bridge", () => {
  it("creates a session cookie with the required privacy attributes", () => {
    const capability = "A".repeat(43);
    const cookie = createInvitationCapabilityCookie(capability);

    expect(cookie).toContain(`recruitment_invitation_capability=${capability}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Max-Age");
    expect(cookie).not.toContain("Domain=");
  });

  it("expires an existing capability after a failed exchange", () => {
    const cookie = clearInvitationCapabilityCookie();

    expect(cookie).toContain("recruitment_invitation_capability=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
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
