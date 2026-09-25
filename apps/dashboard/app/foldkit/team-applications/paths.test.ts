import { fileURLToPath } from "node:url";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { Option, Schema as S } from "effect";
import { Scene } from "foldkit/test";
import { matchRoutes, type RouteObject } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardMount } from "../../../dashboard-base";
import { makeReactRouterConfig } from "../../../react-router.config";
import { navigationSections } from "../dashboard/navigation";
import { init, TeamId, type Model } from "./model";
import { view } from "./view";

const origin = "https://dashboard.test";

/** A team page as the browser addresses it, with a team id that needs encoding. */
const teamPage = new URL("/dashboard/teamsoknader/team%20it", origin);

const chooserFile = "routes/dashboard.teamsoknader._index.tsx";

type RouteTable = { readonly routes: RouteObject[]; readonly basename: string };

// A flat-routes index file such as `dashboard.teamsoknader._index.tsx` keeps its own path.
const toRouteObject = (route: RouteConfigEntry): RouteObject =>
  route.index === true
    ? { id: route.file, index: true, path: route.path }
    : { id: route.file, path: route.path, children: route.children?.map(toRouteObject) };

/** Evaluates the real `app/routes.ts` and `react-router.config.ts` for one dashboard mount. */
const routeTable = async (mount: DashboardMount): Promise<RouteTable> => {
  vi.stubEnv("DASHBOARD_MOUNT", mount);
  vi.resetModules();
  // React Router's config loader hands `flatRoutes` the app directory through this global.
  Object.assign(globalThis, {
    __reactRouterAppDirectory: fileURLToPath(new URL("../..", import.meta.url)),
  });

  // `routes.ts` reads the mount and the app directory when it evaluates, so each mount
  // evaluates a fresh copy instead of a static import.
  const { default: routes } = await import("../../routes");

  return {
    routes: (await routes).map(toRouteObject),
    basename: makeReactRouterConfig({ DASHBOARD_MOUNT: mount }).basename ?? "/",
  };
};

const routeFileAt = (table: RouteTable, url: URL): string | undefined =>
  matchRoutes(table.routes, url.pathname, table.basename)?.at(-1)?.route.id;

/** The `href` of a link that the team application view renders for a loading team page. */
const renderedHref = (linkName: string): string => {
  let href = Option.none<string>();

  Scene.scene(
    { view, update: (model: Model) => ({ model }) },
    Scene.given(
      init(
        S.decodeUnknownSync(TeamId)("team it"),
        IdempotencyKey.make("seed-0123456789abcdefghij"),
      ),
    ),
    Scene.tap(({ html }) => {
      href = Scene.role("link", { name: linkName })(html).pipe(Option.flatMap(Scene.attr("href")));
    }),
  );

  return Option.getOrThrow(href);
};

afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, "__reactRouterAppDirectory");
});

describe.each(["/dashboard/", "/"] as const)("team application links under the %s mount", (mount) => {
  it("lead from a team page back to the team chooser", async () => {
    const table = await routeTable(mount);

    expect(routeFileAt(table, teamPage)).toBe("routes/dashboard.teamsoknader.$teamId.tsx");
    expect(routeFileAt(table, new URL(renderedHref("Velg et annet team"), teamPage))).toBe(
      chooserFile,
    );
  });

  it("lead from the dashboard navigation to the team chooser", async () => {
    const table = await routeTable(mount);

    const navigationLink = navigationSections
      .flatMap((section) => section.entries)
      .flatMap((entry) => (entry.kind === "link" ? [entry.link] : entry.links))
      .find((link) => link.label === "Team-søknader");

    expect(navigationLink).toBeDefined();
    expect(routeFileAt(table, new URL(navigationLink?.href ?? "", teamPage))).toBe(chooserFile);
  });
});
