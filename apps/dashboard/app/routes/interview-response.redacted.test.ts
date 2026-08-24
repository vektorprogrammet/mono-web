import { describe, expect, it } from "vitest";
import { loader } from "./interview-response.redacted";

const load = (url: string) => loader({ request: new Request(url) } as never);

const thrownResponse = (url: string): Response => {
  try {
    load(url);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("invalid redacted invitation binding was accepted");
};

describe("redacted invitation response route", () => {
  it("exposes only one validated interaction id to the custom element boundary", () => {
    const interactionId = "a".repeat(32);

    expect(
      load(`http://dashboard.test/interview-response/redacted?interactionId=${interactionId}`),
    ).toEqual({ interactionId });
  });

  it("rejects missing, malformed, duplicate, and excess interaction parameters", () => {
    const interactionId = "b".repeat(32);
    const invalidUrls = [
      "http://dashboard.test/interview-response/redacted",
      "http://dashboard.test/interview-response/redacted?interactionId=malformed",
      `http://dashboard.test/interview-response/redacted?interactionId=${interactionId}&interactionId=${interactionId}`,
      `http://dashboard.test/interview-response/redacted?interactionId=${interactionId}&extra=true`,
    ];

    for (const url of invalidUrls) {
      const response = thrownResponse(url);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
