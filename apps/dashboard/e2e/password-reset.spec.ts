import { test, expect } from "@playwright/test";
import { dashboardMount } from "../dashboard-base";

// The Playwright web server serves the dashboard below its mount, which prefixes every page and link.
const mounted = (path: string): string => `${dashboardMount(process.env)}${path}`;

test.describe("Forgot password page", () => {
  test("renders forgot password form", async ({ page }) => {
    await page.goto(mounted("glemt-passord"));

    await expect(page.getByRole("heading", { name: "Glemt passord" })).toBeVisible();
    await expect(page.getByLabel("E-post")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send tilbakestillingslenke" })).toBeVisible();
  });

  test("has link back to login", async ({ page }) => {
    await page.goto(mounted("glemt-passord"));

    const link = page.getByRole("link", { name: "Tilbake til innlogging" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", mounted("login"));
  });
});

// The reset link carries its token in the query; tools/acceptance/password-recovery-check.ts
// drives a real token through this page.
test.describe("Reset password page", () => {
  test("renders the new password form for a link with a token", async ({ page }) => {
    await page.goto(mounted("tilbakestill-passord?token=test-token"));

    await expect(page.getByRole("heading", { name: "Tilbakestill passord" })).toBeVisible();
    await expect(page.getByLabel("Nytt passord")).toBeVisible();
    await expect(page.getByLabel("Gjenta passord")).toBeVisible();
    await expect(page.getByRole("button", { name: "Lagre passord" })).toBeVisible();
  });

  test("rejects a link without a token and offers a new one", async ({ page }) => {
    await page.goto(mounted("tilbakestill-passord"));

    await expect(page.getByText("Lenken er ugyldig eller utløpt.")).toBeVisible();
    await expect(page.getByLabel("Nytt passord")).toHaveCount(0);

    const link = page.getByRole("link", { name: "Be om ny lenke" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", mounted("glemt-passord"));
  });
});
