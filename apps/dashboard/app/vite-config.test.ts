import { describe, expect, it } from "vitest";
import { dashboardAssetBase, previewDevtoolsBuildEnabled } from "../vite.config";

describe("dashboardAssetBase", () => {
  it("serves client assets from the runner-owned origin during an Organization import rehearsal", () => {
    expect(dashboardAssetBase({ ORGANIZATION_IMPORT_REHEARSAL: "1" })).toBe("/");
  });

  it("preserves the existing production and conduct journey bases", () => {
    expect(dashboardAssetBase({})).toBe("/dashboard/");
    expect(dashboardAssetBase({ REAL_NATIVE_CONDUCT_E2E: "1" })).toBe("/");
  });
});

describe("previewDevtoolsBuildEnabled", () => {
  it("enables local Vite serve without an environment flag", () => {
    expect(previewDevtoolsBuildEnabled("serve", {})).toBe(true);
  });

  it("fails closed for production builds unless the preview flag is exactly true", () => {
    expect(previewDevtoolsBuildEnabled("build", {})).toBe(false);
    expect(previewDevtoolsBuildEnabled("build", { VITE_PREVIEW_DEVTOOLS: "false" })).toBe(false);
    expect(previewDevtoolsBuildEnabled("build", { VITE_PREVIEW_DEVTOOLS: "TRUE" })).toBe(false);
    expect(previewDevtoolsBuildEnabled("build", { VITE_PREVIEW_DEVTOOLS: "true" })).toBe(true);
  });
});
