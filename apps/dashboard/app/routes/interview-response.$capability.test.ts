import { beforeEach, describe, expect, it, vi } from "vitest";

const createInvitationCapabilityCookie = vi.hoisted(() => vi.fn(() => "invitation-cookie"));
const readInvitationCapability = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../lib/interview-bridge.server", () => ({
  createInvitationCapabilityCookie,
  createInvitationInteractionId: () => "a".repeat(32),
  readInvitationCapability,
  responseHeaders: { "Cache-Control": "no-store" },
}));

import { loader } from "./interview-response.$capability";

const redirectFrom = async (url: string, capability: string): Promise<Response> => {
  try {
    await loader({
      params: { capability },
      request: new Request(url),
    } as never);
  } catch (cause) {
    if (cause instanceof Response) return cause;
    throw cause;
  }
  throw new Error("exchange loader did not redirect");
};

describe("recruitment invitation capability exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the redacted redirect and bridge cookie inside the dashboard mount", async () => {
    const capability = "A".repeat(43);
    const response = await redirectFrom(
      `https://example.test/dashboard/interview-response/${capability}/`,
      capability,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/dashboard/interview-response/redacted?interactionId=${"a".repeat(32)}`,
    );
    expect(createInvitationCapabilityCookie).toHaveBeenCalledWith(
      "a".repeat(32),
      capability,
      "/dashboard/interview",
    );
  });

  it("keeps invalid exchanges inside the current mount", async () => {
    const response = await redirectFrom(
      "https://example.test/dashboard/interview-response/redacted",
      "redacted",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/dashboard/interview-response/redacted");
    expect(readInvitationCapability).not.toHaveBeenCalled();
  });
});
