import { test, expect } from "@playwright/test";
const nativeIdentityMode = process.env.REAL_NATIVE_IDENTITY_E2E === "1";

test.describe("Login page", () => {
  test("renders login form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Vektorprogrammet" })).toBeVisible();
    await expect(page.getByLabel("E-post")).toBeVisible();
    await expect(page.getByLabel("Passord")).toBeVisible();
    await expect(page.getByRole("button", { name: "Logg inn" })).toBeVisible();
  });

  test("shows error on invalid credentials", async ({ page }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    await page.goto("/login");
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
    await page.getByLabel("E-post").fill("invalid@test.com");
    await page.getByLabel("Passord").fill("wrongpassword");
    await page.getByRole("button", { name: "Logg inn" }).click();

    await expect(page.getByText("Feil e-post eller passord")).toBeVisible();
  });

  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/login/);
  });

  test("shows session expiry banner", async ({ page }) => {
    await page.goto("/login?expired=true");

    await expect(page.getByText("Økten din har utløpt")).toBeVisible();
  });

  test("shows password reset banner", async ({ page }) => {
    await page.goto("/login?reset=true");

    await expect(page.getByText("Passordet ditt er tilbakestilt")).toBeVisible();
  });

  test("has forgot password link", async ({ page }) => {
    await page.goto("/login");

    const link = page.getByRole("link", { name: "Glemt passord?" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/glemt-passord");
  });
});
