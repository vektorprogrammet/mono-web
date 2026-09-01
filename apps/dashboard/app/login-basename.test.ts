import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, Form, redirect, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { dashboardMount } from "../dashboard-base";

const LoginForm = () => createElement(Form, { method: "post" });

const mountedLoginRouter = () =>
  createMemoryRouter(
    [
      {
        path: "login",
        Component: LoginForm,
        action: () => redirect("/"),
      },
      {
        index: true,
        element: createElement("main", null, "Dashboard"),
      },
    ],
    {
      basename: dashboardMount({}),
      initialEntries: ["/dashboard/login"],
    },
  );

describe("mounted login navigation", () => {
  it("renders the login Form action once under the dashboard basename", () => {
    const router = mountedLoginRouter();

    const markup = renderToString(createElement(RouterProvider, { router }));

    expect(markup).toContain('action="/dashboard/login"');
    expect(markup).not.toContain('action="/dashboard/dashboard/login"');
  });

  it("projects an app-relative successful-login redirect to the dashboard mount", async () => {
    const router = mountedLoginRouter();

    await router.navigate("/login", {
      formMethod: "post",
      formData: new FormData(),
    });

    expect(router.state.location.pathname).toBe("/dashboard/");
  });
});
