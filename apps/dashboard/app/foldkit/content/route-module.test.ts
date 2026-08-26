import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const ParentDashboardBoundary = () =>
  createElement("main", { "data-dashboard-boundary": "true" }, createElement(Outlet));

describe("Content child route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mounts the article workspace under its parent without owning a loader or request path", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);

    // The import is delayed so the request spy also covers route-module evaluation.
    const contentRoute = await import("../../routes/dashboard.artikler._index");
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/dashboard/artikler"] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { path: "/dashboard", element: createElement(ParentDashboardBoundary) },
            createElement(Route, {
              path: "artikler",
              element: createElement(contentRoute.default),
            }),
          ),
        ),
      ),
    );

    expect(Object.keys(contentRoute)).toEqual(["default"]);
    expect(request).not.toHaveBeenCalled();
    expect(markup).toBe(
      '<main data-dashboard-boundary="true"><vektor-article-workspace></vektor-article-workspace></main>',
    );
  });
});
