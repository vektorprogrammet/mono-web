import { describe, expect, it } from "vitest";
import { validateDashboardPreviewStage } from "./preview-stage";

describe("dashboard preview stage", () => {
  it("preserves the p20 host and stage", () => {
    expect(validateDashboardPreviewStage("p20", "p20.vektor.phibkro.org")).toBe("p20");
  });

  it("accepts the dev-main apex pair", () => {
    expect(validateDashboardPreviewStage("dev-main", "vektor.phibkro.org")).toBe("dev-main");
  });

  it.each([
    ["p20", "vektor.phibkro.org"],
    ["dev-main", "p20.vektor.phibkro.org"],
    ["production", "vektor.phibkro.org"],
  ])("rejects invalid stage-host pair %s / %s", (stage, host) => {
    expect(() => validateDashboardPreviewStage(stage, host)).toThrow();
  });
});
