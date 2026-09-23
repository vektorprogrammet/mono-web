import { describe, expect, it } from "vitest";
import { isDashboardPreviewHost, validateDashboardPreviewStage } from "./preview-stage";

describe("dashboard preview stage", () => {
  it("preserves the p20 host and stage", () => {
    const stage = validateDashboardPreviewStage("p20", "p20.vektor.phibkro.org");
    expect(stage).toBe("p20");
    expect(isDashboardPreviewHost(stage, "p20.vektor.phibkro.org", "p20.vektor.phibkro.org")).toBe(
      true,
    );
  });

  it("accepts the dev-main apex pair", () => {
    expect(validateDashboardPreviewStage("dev-main", "vektor.phibkro.org")).toBe("dev-main");
  });

  it("accepts only workers.dev hosts for an explicit Worker Preview", () => {
    const stage = validateDashboardPreviewStage("worker-preview", undefined, ".workers.dev");
    expect(
      isDashboardPreviewHost(
        stage,
        "pr-42-dashboard.account.workers.dev",
        undefined,
        ".workers.dev",
      ),
    ).toBe(true);
    expect(isDashboardPreviewHost(stage, "vektorprogrammet.no", undefined, ".workers.dev")).toBe(
      false,
    );
  });

  it.each([
    ["p20", "vektor.phibkro.org", undefined],
    ["dev-main", "p20.vektor.phibkro.org", undefined],
    ["production", "vektor.phibkro.org", undefined],
    ["worker-preview", undefined, undefined],
    ["worker-preview", "pr-42-dashboard.account.workers.dev", ".workers.dev"],
  ])("rejects invalid stage-host configuration %s / %s / %s", (stage, host, suffix) => {
    expect(() => validateDashboardPreviewStage(stage, host, suffix)).toThrow();
  });
});
