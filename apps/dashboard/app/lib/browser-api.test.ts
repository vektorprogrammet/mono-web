import { describe, expect, it } from "vitest";
import { resolveBrowserApiUrl } from "./browser-api";

describe("dashboard browser API origin", () => {
  it("accepts only the current browser origin", () => {
    expect(
      resolveBrowserApiUrl("https://vektor.phibkro.org", "https://vektor.phibkro.org/dashboard"),
    ).toBe("https://vektor.phibkro.org");
  });

  it.each([
    undefined,
    "",
    "http://127.0.0.1:8790",
    "https://origin-api.vektor.phibkro.org",
    "https://p20.vektor.phibkro.org",
  ])("rejects non-apex browser destination %j", (configuredUrl) => {
    expect(() => resolveBrowserApiUrl(configuredUrl, "https://vektor.phibkro.org")).toThrow();
  });
});
