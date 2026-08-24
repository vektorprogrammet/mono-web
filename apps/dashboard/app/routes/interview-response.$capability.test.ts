import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  readInvitationCapability: vi.fn(),
  createInvitationCapabilityCookie: vi.fn(
    (capability: string) =>
      `recruitment_invitation_capability=${capability}; HttpOnly; SameSite=Strict`,
  ),
  clearInvitationCapabilityCookie: vi.fn(
    () => "recruitment_invitation_capability=; HttpOnly; SameSite=Strict; Max-Age=0",
  ),
}));

vi.mock("../lib/interview-bridge.server", () => ({
  ...bridge,
  responseHeaders: {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  },
}));

import { loader } from "./interview-response.$capability";

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
    bridge.createInvitationCapabilityCookie.mockClear();
    bridge.clearInvitationCapabilityCookie.mockClear();
  });

  it("validates once, stores the server-held cookie, and redirects to the redacted route", async () => {
    const capability = "A".repeat(43);
    const response = await thrownRedirect(capability);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/interview-response/redacted");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(bridge.readInvitationCapability).toHaveBeenCalledWith(capability);
    expect(bridge.createInvitationCapabilityCookie).toHaveBeenCalledWith(capability);
  });

  it("clears an older cookie when the supplied capability is malformed, unknown, or superseded", async () => {
    bridge.readInvitationCapability.mockRejectedValueOnce(new Error("opaque not found"));
    const response = await thrownRedirect("invalid");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/interview-response/redacted");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(bridge.createInvitationCapabilityCookie).not.toHaveBeenCalled();
    expect(bridge.clearInvitationCapabilityCookie).toHaveBeenCalledOnce();
  });

  it("does not exchange the redacted route sentinel", async () => {
    const response = await thrownRedirect("redacted");

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(bridge.readInvitationCapability).not.toHaveBeenCalled();
  });
});
