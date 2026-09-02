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
    id: "dashboard",
    path: "dashboard",
    file: "routes/dashboard.tsx",
    children: [
      {
        id: "owned-receipts",
        path: "mine-utlegg",
        file: "routes/dashboard.mine-utlegg._index.tsx",
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

  it("preserves dashboard route paths for an explicit apex root mount", () => {
    const apexEnvironment = {
      DASHBOARD_MOUNT: "/",
      PREVIEW_HOST: "vektor.phibkro.org",
    };
    const config = makeReactRouterConfig(apexEnvironment);

    expect(config.basename).toBe("/");
    expect(matchedIds("/login", apexEnvironment)).toEqual(["login"]);
    expect(matchedIds("/dashboard", apexEnvironment)).toEqual(["dashboard"]);
    expect(matchedIds("/dashboard/mine-utlegg", apexEnvironment)).toEqual([
      "dashboard",
      "owned-receipts",
    ]);
  });

  it("does not infer the root mount from a preview hostname", () => {
    expect(makeReactRouterConfig({ PREVIEW_HOST: "vektor.phibkro.org" }).basename).toBe(
      "/dashboard/",
    );
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
    ).toEqual(["http://127.0.0.1:5175"]);
    expect(
      makeReactRouterConfig({
        DASHBOARD_ORIGIN: "https://dashboard.example.invalid",
        PREVIEW_HOST: "preview.example.invalid",
      }).allowedActionOrigins,
    ).toEqual(["https://preview.example.invalid", "https://dashboard.example.invalid"]);
    expect(
      makeReactRouterConfig({
        DASHBOARD_ORIGIN: "http://untrusted.example.invalid",
      }).allowedActionOrigins,
    ).toBeUndefined();
  });
});
