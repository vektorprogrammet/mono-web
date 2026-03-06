import { test, expect } from "@playwright/test";

test.describe("Forgot password page", () => {
  test("renders forgot password form", async ({ page }) => {
    await page.goto("/glemt-passord");

    await expect(
      page.getByRole("heading", { name: "Glemt passord" }),
    ).toBeVisible();
    await expect(page.getByLabel("E-post")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send tilbakestillingslenke" }),
    ).toBeVisible();
  });

  test("has link back to login", async ({ page }) => {
    await page.goto("/glemt-passord");

    const link = page.getByRole("link", { name: "Tilbake til innlogging" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/login");
  });
});

test.describe("Reset password page", () => {
  test("renders reset password form", async ({ page }) => {
    await page.goto("/tilbakestill-passord/test-code");

    await expect(
      page.getByRole("heading", { name: "Nytt passord" }),
    ).toBeVisible();
    await expect(page.getByLabel("Nytt passord")).toBeVisible();
    await expect(page.getByLabel("Bekreft passord")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tilbakestill passord" }),
    ).toBeVisible();
  });

  test("has link back to login", async ({ page }) => {
    await page.goto("/tilbakestill-passord/test-code");

    const link = page.getByRole("link", { name: "Tilbake til innlogging" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/login");
  });
});
