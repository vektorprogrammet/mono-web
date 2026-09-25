import type { RouteConfigEntry } from "@react-router/dev/routes";
import { describe, expect, it } from "vitest";
import { matchRoutes, type RouteObject } from "react-router";
import { makeReactRouterConfig } from "../react-router.config";
import {
  type DashboardBaseEnvironment,
  dashboardMount,
  mountDashboardRoutes,
} from "../dashboard-base";

const dashboardRouteConfig = [
  { id: "login", path: "login", file: "routes/login.tsx" },
  {
    id: "recruitment-bridge",
    path: "recruitment",
    file: "routes/__foldkit.recruitment.ts",
  },
  {
    id: "dashboard",
    path: "dashboard",
    file: "routes/dashboard.tsx",
    children: [
      {
        id: "owned-receipts",
        path: "mine-utlegg",
        file: "routes/dashboard.mine-utlegg._index.tsx",
      },
      {
        id: "profile",
        path: "profile",
        file: "routes/dashboard.profile._index.tsx",
      },
      {
        id: "approval-receipt-file",
        path: "utlegg/:receiptId/file",
        file: "routes/dashboard.utlegg.$receiptId.file.ts",
      },
    ],
  },
] satisfies ReadonlyArray<RouteConfigEntry>;

const toRouteObject = (route: RouteConfigEntry): RouteObject =>
  route.index === true
    ? { id: route.id, index: true }
    : {
        id: route.id,
        path: route.path,
        children: route.children?.map(toRouteObject),
      };

const matchedIds = (
  pathname: string,
  environment: DashboardBaseEnvironment,
): Array<string | undefined> => {
  const mount = dashboardMount(environment);
  const routes = mountDashboardRoutes(dashboardRouteConfig, mount).map(toRouteObject);

  return matchRoutes(routes, pathname, mount)?.map((match) => match.route.id) ?? [];
};

describe("dashboard router topology", () => {
  it("mounts the login route below the canonical dashboard base", () => {
    const config = makeReactRouterConfig({});

    expect(config.basename).toBe("/dashboard/");
    expect(matchedIds("/dashboard/login", {})).toEqual(["login"]);
  });

  it("does not duplicate the dashboard segment for a nested dashboard route", () => {
    expect(matchedIds("/dashboard/mine-utlegg", {})).toEqual(["dashboard", "owned-receipts"]);
    expect(matchedIds("/dashboard/dashboard/mine-utlegg", {})).toEqual([]);
  });

  it("keeps the approval receipt file resource under the dashboard layout", () => {
    expect(matchedIds("/dashboard/utlegg/receipt-approval-file/file", {})).toEqual([
      "dashboard",
      "approval-receipt-file",
    ]);
  });

  it("preserves dashboard route paths for an explicit root mount", () => {
    const rootEnvironment = { DASHBOARD_MOUNT: "/" };

    const config = makeReactRouterConfig(rootEnvironment);

    expect(config.basename).toBe("/");
    expect(matchedIds("/dashboard/utlegg/receipt-approval-file/file", rootEnvironment)).toEqual([
      "dashboard",
      "approval-receipt-file",
    ]);
    expect(matchedIds("/login", rootEnvironment)).toEqual(["login"]);
    expect(matchedIds("/recruitment", rootEnvironment)).toEqual(["recruitment-bridge"]);
    expect(matchedIds("/dashboard", rootEnvironment)).toEqual(["dashboard"]);
    expect(matchedIds("/dashboard/profile", rootEnvironment)).toEqual(["dashboard", "profile"]);
    expect(matchedIds("/dashboard/mine-utlegg", rootEnvironment)).toEqual([
      "dashboard",
      "owned-receipts",
    ]);
  });

  it("leaves an unknown dashboard descendant unmatched at the root-mounted dashboard", () => {
    expect(matchedIds("/dashboard/recruitment", { DASHBOARD_MOUNT: "/" })).toEqual([]);
  });

  it("keeps root-mounted runner modes aligned with the Vite asset base", () => {
    const environment = { REAL_NATIVE_CONDUCT_E2E: "1" };

    expect(makeReactRouterConfig(environment).basename).toBe("/");
    expect(matchedIds("/login", environment)).toEqual(["login"]);
    expect(matchedIds("/dashboard", environment)).toEqual(["dashboard"]);
  });

  it("rejects an unsupported explicit dashboard mount", () => {
    expect(() => makeReactRouterConfig({ DASHBOARD_MOUNT: "/admin/" })).toThrow(
      "DASHBOARD_MOUNT must be exactly / or /dashboard/",
    );
  });

  it("allows only an explicit canonical dashboard origin for forwarded actions", () => {
    expect(
      makeReactRouterConfig({
        DASHBOARD_ORIGIN: "http://127.0.0.1:5175",
      }).allowedActionOrigins,
    ).toEqual(["127.0.0.1:5175"]);
    expect(
      makeReactRouterConfig({
        DASHBOARD_ORIGIN: "https://dashboard.example.invalid",
        PREVIEW_HOST: "preview.example.invalid",
      }).allowedActionOrigins,
    ).toEqual(["dashboard.example.invalid"]);
    expect(
      makeReactRouterConfig({
        DASHBOARD_ORIGIN: "http://untrusted.example.invalid",
      }).allowedActionOrigins,
    ).toBeUndefined();
  });
});
