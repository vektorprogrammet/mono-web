import { test, expect } from "@playwright/test";
import { dashboardMount } from "../dashboard-base";

// The Playwright web server serves the dashboard below its mount, which prefixes every page and link.
const mounted = (path: string): string => `${dashboardMount(process.env)}${path}`;

test.describe("Login page", () => {
  test("renders login form", async ({ page }) => {
    await page.goto(mounted("login"));

    await expect(page.getByRole("heading", { name: "Vektorprogrammet" })).toBeVisible();
    await expect(page.getByLabel("E-post")).toBeVisible();
    await expect(page.getByLabel("Passord")).toBeVisible();
    await expect(page.getByRole("button", { name: "Logg inn" })).toBeVisible();
  });

  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto(mounted(""));

    await expect(page).toHaveURL((url) => url.pathname === mounted("login"));
  });

  test("shows session expiry banner", async ({ page }) => {
    await page.goto(mounted("login?expired=true"));

    await expect(page.getByText("Økten din har utløpt")).toBeVisible();
  });

  test("shows password reset banner", async ({ page }) => {
    await page.goto(mounted("login?reset=true"));

    await expect(page.getByText("Passordet ditt er tilbakestilt")).toBeVisible();
  });

  test("has forgot password link", async ({ page }) => {
    await page.goto(mounted("login"));

    const link = page.getByRole("link", { name: "Glemt passord?" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", mounted("glemt-passord"));
  });
});
