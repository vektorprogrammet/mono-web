import { describe, expect, it } from "vitest";
import { isDashboardPreviewHost, validateDashboardPreviewStage } from "./preview-stage";

describe("dashboard preview stage", () => {
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
    expect(isDashboardPreviewHost(stage, ".workers.dev", undefined, ".workers.dev")).toBe(false);
  });

  it.each([
    ["p20", "p20.vektor.phibkro.org", undefined],
    ["dev-main", "vektor.phibkro.org", undefined],
    ["production", undefined, ".workers.dev"],
    ["worker-preview", undefined, undefined],
    ["worker-preview", "pr-42-dashboard.account.workers.dev", ".workers.dev"],
  ])("rejects invalid stage-host configuration %s / %s / %s", (stage, host, suffix) => {
    expect(() => validateDashboardPreviewStage(stage, host, suffix)).toThrow();
  });
});
