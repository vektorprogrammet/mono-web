import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("Dashboard home page", () => {
  test("should not have any automatically detectable accessibility issues", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test("has title", async ({ page }) => {
    await page.goto("/dashboard");

    // Expect a title "to contain" a substring.
    await expect(page).toHaveTitle(/Dashboard/);
  });

  test("has heading", async ({ page }) => {
    await page.goto("/dashboard");

    // Click the get started link.
    // await page.getByRole("link", { name: "Get started" }).click();

    // Expects page to have a heading with the name of Installation.
    await expect(
      page.getByRole("heading", { name: "Dashboard" }),
    ).toBeVisible();
  });
});
