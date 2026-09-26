import { fileURLToPath } from "node:url";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rewriteBackendRedirect, singleOriginTarget } from "./single-origin";

const publicOrigin = "https://preview.example.invalid";

const backendOrigin = "https://backend.example.invalid";

const request = (path: string, method = "GET") => new Request(`${publicOrigin}${path}`, { method });

/** First path segments of an application's flat route files, as React Router reads them. */
const routeFamilies = async (appDirectory: URL): Promise<ReadonlyArray<string>> => {
  // React Router's config loader hands `flatRoutes` the app directory through this global.
  vi.stubGlobal("__reactRouterAppDirectory", fileURLToPath(appDirectory));

  const families = (routes: ReadonlyArray<RouteConfigEntry>): Array<string> =>
    routes.flatMap((route) =>
      route.path === undefined ? families(route.children ?? []) : [route.path.split("/")[0]],
    );

  return families(await flatRoutes());
};

afterEach(() => vi.unstubAllGlobals());

describe("singleOriginTarget", () => {
  it.each([
    "/login",
    "/content?operation=load",
    "/content.data",
    "/dashboard/not-a-route",
    "/profile/rediger.data",
    "/interview-response/accept.data",
  ])("routes dashboard path %s to the dashboard", (path) => {
    expect(singleOriginTarget(request(path))).toEqual({ kind: "dashboard" });
  });

  it.each([
    "/",
    "/nyheter",
    "/nyheter.data",
    "/interview-guidelines",
    "/profiles",
    "/constructor",
    "/kontrollpanel/skoler",
    "/vektor-logo-circle.svg",
  ])("routes public path %s to the homepage", (path) => {
    expect(singleOriginTarget(request(path))).toEqual({ kind: "homepage" });
  });

  it("routes every family of the dashboard route config to the dashboard", async () => {
    const families = await routeFamilies(new URL("../app/", import.meta.url));

    // `flatRoutes` finds no routes in a missing directory; a known family proves the scan worked.
    expect(families).toContain("interview-response");

    for (const family of families) {
      expect(singleOriginTarget(request(`/${family}`)), family).toEqual({ kind: "dashboard" });
    }
  });

  it("routes every family of the homepage route config to the homepage", async () => {
    const families = await routeFamilies(new URL("../../homepage/src/", import.meta.url));

    // `flatRoutes` finds no routes in a missing directory; a known family proves the scan worked.
    expect(families).toContain("nyheter");

    for (const family of families) {
      expect(singleOriginTarget(request(`/${family}`)), family).toEqual({ kind: "homepage" });
    }
  });

  it("routes a route manifest patch to the application that owns the requested paths", () => {
    expect(
      singleOriginTarget(
        request(
          "/__manifest?paths=%2Finterview-response%2C%2Finterview-response%2Faccept&version=abc",
        ),
      ),
    ).toEqual({ kind: "dashboard" });
    expect(
      singleOriginTarget(
        request("/__manifest?paths=%2Fnyheter%2C%2Fnyheter%2Farticle&version=abc"),
      ),
    ).toEqual({ kind: "homepage" });
  });

  it("asks the dashboard, then the homepage, only for asset reads", () => {
    const asset = { kind: "asset", order: ["dashboard", "homepage"] };

    expect(singleOriginTarget(request("/assets/entry.abc123.js"))).toEqual(asset);
    expect(singleOriginTarget(request("/assets/entry.abc123.js", "HEAD"))).toEqual(asset);
    expect(singleOriginTarget(request("/assets/entry.abc123.js", "POST"))).toEqual({
      kind: "homepage",
    });
  });

  it.each([
    ["/kontrollpanel", "/login?redirectTo=%2Fdashboard"],
    ["/kontrollpanel.data", "/login?redirectTo=%2Fdashboard"],
    ["/kontrollpanel?from=legacy", "/login?from=legacy"],
  ])("redirects the legacy bookmark %s to %s", (path, location) => {
    expect(singleOriginTarget(request(path))).toEqual({ kind: "redirect", status: 302, location });
  });

  it.each([
    ["GET", "/api/health", "/health"],
    ["GET", "/health", "/health"],
    ["POST", "/api/auth/sign-in/email?continue=1", "/api/auth/sign-in/email?continue=1"],
  ])("sends %s %s to backend path %s", (method, path, backendPath) => {
    expect(singleOriginTarget(request(path, method))).toEqual({
      kind: "backend",
      path: backendPath,
    });
  });
});

describe("rewriteBackendRedirect", () => {
  it.each([
    [`${backendOrigin}/dashboard`, `${publicOrigin}/dashboard`],
    ["/dashboard?from=backend#ready", `${publicOrigin}/dashboard?from=backend#ready`],
    ["profile?from=backend", `${publicOrigin}/profile?from=backend`],
    [`${backendOrigin}//evil.example.invalid/path`, `${publicOrigin}//evil.example.invalid/path`],
  ])("moves backend redirect %s onto the public origin as %s", (location, rewritten) => {
    expect(rewriteBackendRedirect(location, backendOrigin, publicOrigin)).toBe(rewritten);
  });

  it.each([
    `${backendOrigin}@evil.example.invalid/path`,
    `${backendOrigin}.evil.example.invalid/path`,
    "//evil.example.invalid/path",
    "//backend.example.invalid/path",
    "https://preview-user@backend.example.invalid/path",
    "https://[invalid/path",
  ])("blocks hostile backend redirect %s", (location) => {
    expect(rewriteBackendRedirect(location, backendOrigin, publicOrigin)).toBeUndefined();
  });
});
