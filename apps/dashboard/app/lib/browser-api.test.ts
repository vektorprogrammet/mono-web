import { describe, expect, it } from "vitest";
import { resolveBrowserApiUrl } from "./browser-api";

describe("dashboard browser API origin", () => {
  it("accepts only the current browser origin", () => {
    expect(
      resolveBrowserApiUrl(
        "https://dashboard.example.invalid",
        "https://dashboard.example.invalid/dashboard",
      ),
    ).toBe("https://dashboard.example.invalid");
  });

  it.each([
    undefined,
    "",
    "http://127.0.0.1:8790",
    "https://api.dashboard.example.invalid",
    "https://other.example.invalid",
  ])("rejects a browser destination other than the current origin %j", (configuredUrl) => {
    expect(() => resolveBrowserApiUrl(configuredUrl, "https://dashboard.example.invalid")).toThrow();
  });
});
