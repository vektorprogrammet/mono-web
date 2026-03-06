import { test, expect } from "@playwright/test";

test.describe("Login page", () => {
  test("renders login form", async ({ page }) => {
    await page.goto("/login");

    await expect(
      page.getByRole("heading", { name: "Vektorprogrammet" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Brukernavn eller e-post"),
    ).toBeVisible();
    await expect(page.getByLabel("Passord")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Logg inn" }),
    ).toBeVisible();
  });

  test("shows error on invalid credentials", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Brukernavn eller e-post").fill("invalid@test.com");
    await page.getByLabel("Passord").fill("wrongpassword");
    await page.getByRole("button", { name: "Logg inn" }).click();

    await expect(
      page.getByText("Feil brukernavn eller passord"),
    ).toBeVisible();
  });

  // Requires a running backend with valid user credentials
  test.skip("redirects to dashboard on successful login", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Brukernavn eller e-post").fill("valid@test.com");
    await page.getByLabel("Passord").fill("correctpassword");
    await page.getByRole("button", { name: "Logg inn" }).click();

    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/login/);
  });

  // Requires authenticated session state to test logout
  test.skip("logout clears session", async ({ _page }) => {
    // Would need to set up auth state first, then trigger logout
    // and verify redirect back to /login
  });

  test("shows session expiry banner", async ({ page }) => {
    await page.goto("/login?expired=true");

    await expect(
      page.getByText("Økten din har utløpt"),
    ).toBeVisible();
  });

  test("shows password reset banner", async ({ page }) => {
    await page.goto("/login?reset=true");

    await expect(
      page.getByText("Passordet ditt er tilbakestilt"),
    ).toBeVisible();
  });

  test("has forgot password link", async ({ page }) => {
    await page.goto("/login");

    const link = page.getByRole("link", { name: "Glemt passord?" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/glemt-passord");
  });
});
