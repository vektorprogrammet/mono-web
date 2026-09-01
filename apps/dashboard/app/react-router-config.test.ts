import type { RouteConfigEntry } from "@react-router/dev/routes";
import { describe, expect, it } from "vitest";
import { matchRoutes, type RouteObject } from "react-router";
import { makeReactRouterConfig } from "../react-router.config";
import { dashboardMount, mountDashboardRoutes } from "../dashboard-base";

const mountedRoutes = mountDashboardRoutes([
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
] satisfies ReadonlyArray<RouteConfigEntry>);

const toRouteObject = (route: RouteConfigEntry): RouteObject =>
  route.index === true
    ? { id: route.id, index: true }
    : {
        id: route.id,
        path: route.path,
        children: route.children?.map(toRouteObject),
      };

const routes = mountedRoutes.map(toRouteObject);

const matchedIds = (pathname: string, basename: string): Array<string | undefined> =>
  matchRoutes(routes, pathname, basename)?.map((match) => match.route.id) ?? [];

describe("dashboard router topology", () => {
  it("mounts the login route below the canonical dashboard base", () => {
    const config = makeReactRouterConfig({});

    expect(config.basename).toBe(dashboardMount({}));
    expect(config.basename).toBe("/dashboard/");
    expect(matchedIds("/dashboard/login", config.basename ?? "/")).toEqual(["login"]);
  });

  it("does not duplicate the dashboard segment for a nested dashboard route", () => {
    const config = makeReactRouterConfig({});

    expect(matchedIds("/dashboard/mine-utlegg", config.basename ?? "/")).toEqual([
      "dashboard",
      "owned-receipts",
    ]);
    expect(matchedIds("/dashboard/dashboard/mine-utlegg", config.basename ?? "/")).toEqual([]);
  });

  it("keeps root-mounted runner modes aligned with the Vite asset base", () => {
    const config = makeReactRouterConfig({ REAL_NATIVE_CONDUCT_E2E: "1" });

    expect(config.basename).toBe(dashboardMount({ REAL_NATIVE_CONDUCT_E2E: "1" }));
    expect(matchedIds("/login", config.basename ?? "/")).toEqual(["login"]);
  });
});
