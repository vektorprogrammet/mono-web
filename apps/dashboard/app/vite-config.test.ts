import { describe, expect, it } from "vitest";
import { dashboardAssetBase } from "../vite.config";

describe("dashboardAssetBase", () => {
  it("serves client assets from the runner-owned origin during an Organization import rehearsal", () => {
    expect(dashboardAssetBase({ ORGANIZATION_IMPORT_REHEARSAL: "1" })).toBe("/");
  });

  it("preserves the existing production and conduct journey bases", () => {
    expect(dashboardAssetBase({})).toBe("/dashboard/");
    expect(dashboardAssetBase({ REAL_NATIVE_CONDUCT_E2E: "1" })).toBe("/");
  });
});
