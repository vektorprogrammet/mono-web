import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const ParentDashboardBoundary = () =>
  createElement("main", { "data-dashboard-boundary": "true" }, createElement(Outlet));

describe("Schools child route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mounts the Schools element under its parent without owning a loader or request path", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);

    // The import is delayed so the request spy also covers route-module evaluation.
    const schoolsRoute = await import("../../routes/dashboard.skoler._index");
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ["/dashboard/skoler"] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { path: "/dashboard", element: createElement(ParentDashboardBoundary) },
            createElement(Route, {
              path: "skoler",
              element: createElement(schoolsRoute.default),
            }),
          ),
        ),
      ),
    );

    expect(Object.keys(schoolsRoute)).toEqual(["default"]);
    expect(request).not.toHaveBeenCalled();
    expect(markup).toBe(
      '<main data-dashboard-boundary="true"><vektor-schools-directory></vektor-schools-directory></main>',
    );
  }, 15_000);
});
