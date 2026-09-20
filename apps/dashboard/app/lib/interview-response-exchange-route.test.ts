import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  readInvitationCapability: vi.fn(),
  createInvitationInteractionId: vi.fn(),
  createInvitationCapabilityCookie: vi.fn(
    (interactionId: string, capability: string, bridgePath: string) =>
      `recruitment_invitation_capability_${interactionId}=${capability}; Path=${bridgePath}; HttpOnly; SameSite=Strict`,
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

const thrownRedirect = async (
  capability: string,
  mount: "/" | "/dashboard/" = "/",
): Promise<Response> => {
  try {
    await loader({
      params: { capability },
      request: new Request(`http://dashboard.test${mount}interview-response/${capability}`),
    } as never);
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
      "/interview",
    );
    expect(bridge.createInvitationCapabilityCookie).toHaveBeenNthCalledWith(
      2,
      secondInteractionId,
      secondCapability,
      "/interview",
    );
    expect(bridge.readInvitationCapability.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.createInvitationInteractionId.mock.invocationCallOrder[0] ?? 0,
    );
    expect(bridge.readInvitationCapability.mock.invocationCallOrder[1]).toBeLessThan(
      bridge.createInvitationInteractionId.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it("keeps the capability cookie inside the configured dashboard mount", async () => {
    const capability = "C".repeat(43);
    const interactionId = "c".repeat(32);
    bridge.createInvitationInteractionId.mockReturnValueOnce(interactionId);

    const response = await thrownRedirect(capability, "/dashboard/");

    expect(response.headers.get("location")).toBe(
      `/interview-response/redacted?interactionId=${interactionId}`,
    );
    expect(response.headers.get("set-cookie")).toContain("Path=/dashboard/interview");
    expect(bridge.createInvitationCapabilityCookie).toHaveBeenCalledWith(
      interactionId,
      capability,
      "/dashboard/interview",
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
