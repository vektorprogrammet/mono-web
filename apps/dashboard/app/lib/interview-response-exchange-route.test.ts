import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  readInvitationCapability: vi.fn(),
  createInvitationInteractionId: vi.fn(),
  createInvitationCapabilityCookie: vi.fn(
    (interactionId: string, capability: string) =>
      `recruitment_invitation_capability_${interactionId}=${capability}; Path=/interview; HttpOnly; SameSite=Strict`,
  ),
}));

vi.mock("./interview-bridge.server", () => ({
  ...bridge,
  responseHeaders: {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  },
}));

import { loader } from "../routes/interview-response.$capability";

const thrownRedirect = async (capability: string): Promise<Response> => {
  try {
    await loader({ params: { capability } } as never);
  } catch (response) {
    if (response instanceof Response) return response;
    throw response;
  }
  throw new Error("capability exchange did not redirect");
};

describe("recruitment invitation capability exchange", () => {
  beforeEach(() => {
    bridge.readInvitationCapability.mockReset().mockResolvedValue({ responseState: "Pending" });
    bridge.createInvitationInteractionId.mockReset();
    bridge.createInvitationCapabilityCookie.mockClear();
  });

  it("mints distinct bindings after validation and redirects each exchange without capability exposure", async () => {
    const firstCapability = "A".repeat(43);
    const secondCapability = "B".repeat(43);
    const firstInteractionId = "a".repeat(32);
    const secondInteractionId = "b".repeat(32);
    bridge.createInvitationInteractionId
      .mockReturnValueOnce(firstInteractionId)
      .mockReturnValueOnce(secondInteractionId);

    const firstResponse = await thrownRedirect(firstCapability);
    const secondResponse = await thrownRedirect(secondCapability);

    expect(firstResponse.status).toBe(302);
    expect(secondResponse.status).toBe(302);
    expect(firstResponse.headers.get("location")).toBe(
      `/interview-response/redacted?interactionId=${firstInteractionId}`,
    );
    expect(secondResponse.headers.get("location")).toBe(
      `/interview-response/redacted?interactionId=${secondInteractionId}`,
    );
    expect(firstResponse.headers.get("location")).not.toContain(firstCapability);
    expect(secondResponse.headers.get("location")).not.toContain(secondCapability);
    expect(firstResponse.headers.get("set-cookie")).toContain(
      `recruitment_invitation_capability_${firstInteractionId}=`,
    );
    expect(secondResponse.headers.get("set-cookie")).toContain(
      `recruitment_invitation_capability_${secondInteractionId}=`,
    );
    expect(firstResponse.headers.get("set-cookie")).not.toBe(
      secondResponse.headers.get("set-cookie"),
    );
    expect(bridge.readInvitationCapability).toHaveBeenNthCalledWith(1, firstCapability);
    expect(bridge.readInvitationCapability).toHaveBeenNthCalledWith(2, secondCapability);
    expect(bridge.createInvitationCapabilityCookie).toHaveBeenNthCalledWith(
      1,
      firstInteractionId,
      firstCapability,
    );
    expect(bridge.createInvitationCapabilityCookie).toHaveBeenNthCalledWith(
      2,
      secondInteractionId,
      secondCapability,
    );
    expect(bridge.readInvitationCapability.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.createInvitationInteractionId.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bridge.readInvitationCapability.mock.invocationCallOrder[1]).toBeLessThan(
      bridge.createInvitationInteractionId.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it("does not mint, replace, or clear a binding when capability validation fails", async () => {
    bridge.readInvitationCapability.mockRejectedValueOnce(new Error("opaque not found"));
    const response = await thrownRedirect("invalid");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/interview-response/redacted");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(bridge.createInvitationInteractionId).not.toHaveBeenCalled();
    expect(bridge.createInvitationCapabilityCookie).not.toHaveBeenCalled();
  });

  it("does not exchange the redacted route sentinel", async () => {
    const response = await thrownRedirect("redacted");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/interview-response/redacted");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(bridge.readInvitationCapability).not.toHaveBeenCalled();
    expect(bridge.createInvitationInteractionId).not.toHaveBeenCalled();
  });
});
