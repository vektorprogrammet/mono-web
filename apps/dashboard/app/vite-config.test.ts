import { describe, expect, it } from "vitest";
import { dashboardMount } from "../dashboard-base";
import { previewDevtoolsBuildEnabled } from "../vite.config";

describe("dashboard mount authority", () => {
  it("mounts runner-owned rehearsal applications at the origin root", () => {
    expect(dashboardMount({ ORGANIZATION_IMPORT_REHEARSAL: "1" })).toBe("/");
  });

  it("keeps the canonical trailing slash for router and Vite URL joins", () => {
    const mount = dashboardMount({});

    expect(mount).toBe("/dashboard/");
    expect(`${mount}@react-router/critical.css`).toBe("/dashboard/@react-router/critical.css");
    expect(`${mount}@react-router/critical.css`).not.toBe("/dashboard@react-router/critical.css");
    expect(dashboardMount({ REAL_NATIVE_CONDUCT_E2E: "1" })).toBe("/");
  });

  it("derives the exact owner login document and data URLs", () => {
    const origin = "http://127.0.0.1:15174";
    const loginDocumentPath = `${dashboardMount({})}login`;

    expect(new URL(loginDocumentPath, origin).toString()).toBe(
      "http://127.0.0.1:15174/dashboard/login",
    );
    expect(new URL(`${loginDocumentPath}.data`, origin).toString()).toBe(
      "http://127.0.0.1:15174/dashboard/login.data",
    );
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
