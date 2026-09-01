import { describe, expect, it } from "vitest";
import { dashboardBaseUrl } from "../dashboard-base";
import { resolveReceiptOwnerDashboardTopology } from "../playwright.config";

describe("Receipt owner Playwright topology", () => {
  it("resolves primary and isolated foreign login navigation under the canonical base", () => {
    const dashboardOrigin = "http://127.0.0.1:15174";
    const environment = {
      REAL_RECEIPT_OWNER_E2E: "1",
      DASHBOARD_ORIGIN: dashboardOrigin,
    };
    const topology = resolveReceiptOwnerDashboardTopology(environment);
    const foreignBaseURL = dashboardBaseUrl(dashboardOrigin, environment);

    expect(topology).toEqual({
      baseURL: "http://127.0.0.1:15174/dashboard/",
      webServer: undefined,
    });
    expect({
      primary: new URL("login", topology?.baseURL).pathname,
      foreign: new URL("login", foreignBaseURL).pathname,
    }).toEqual({
      primary: "/dashboard/login",
      foreign: "/dashboard/login",
    });
  });

  it("rejects Receipt owner mode without the runner-provided dashboard origin", () => {
    expect(() => resolveReceiptOwnerDashboardTopology({ REAL_RECEIPT_OWNER_E2E: "1" })).toThrow(
      "DASHBOARD_ORIGIN is required for REAL_RECEIPT_OWNER_E2E",
    );
  });
});
