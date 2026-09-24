import { expect, test } from "@playwright/test";

const nativeIdentityMode = process.env.REAL_NATIVE_IDENTITY_E2E === "1";

const adminEmail = "admin.journey@example.invalid";

const adminPassword = "journey-secret-2026";

test.describe("Native authenticated session journey (spec 0054)", () => {
  test("signs in through a native form before hydration", async ({ browser, baseURL }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");
    const context = await browser.newContext({ javaScriptEnabled: false });

    try {
      const page = await context.newPage();
      const origin = new URL(baseURL!).origin;
      const mount = process.env.DASHBOARD_MOUNT ?? "/";
      const login = new URL(`${mount}login`, origin);
      login.searchParams.set("redirectTo", "/");
      await page.goto(login.href);
      await page.getByLabel("E-post").fill(adminEmail);
      await page.getByLabel("Passord").fill(adminPassword);
      const submitted = page.waitForRequest((request) => request.method() === "POST");
      await page.getByRole("button", { name: "Logg inn", exact: true }).click();
      const request = await submitted;
      expect(request.headers().origin).toBe(origin);
      expect(request.headers().referer).toBe(`${origin}/`);
      await expect(page.getByText("Journey Admin", { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("signs in, keeps the session across reload, and signs out back to login", async ({
    page,
    context,
  }) => {
    test.skip(!nativeIdentityMode, "requires the real native identity topology");

    // Sign in through the real login form.
    await page.goto("/login");
    await page.getByLabel("E-post").fill(adminEmail);
    await page.getByLabel("Passord").fill(adminPassword);
    await page.getByRole("button", { name: "Logg inn" }).click();
    await page.waitForURL(/\/dashboard$/);

    // The native better-auth session cookie must exist in the browser context.
    const sessionToken = (await context.cookies()).find(
      (cookie) => cookie.name === "better-auth.session_token",
    );

    expect(sessionToken?.value ?? "").not.toBe("");

    // The dashboard resolved the profile behind the session.
    await expect(page.getByText("Journey Admin")).toBeVisible();

    // Reload: the session survives and the dashboard renders again.
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText("Journey Admin")).toBeVisible();

    // Sign out through the user menu (POST /logout via the rendered form).
    await page.getByRole("button", { name: new RegExp(adminEmail) }).click();
    await page.getByRole("menuitem", { name: "Logg ut" }).click();
    await page.waitForURL(/\/login$/);

    // The session cookie is gone after sign-out.
    const cookiesAfterLogout = await context.cookies();
    expect(
      cookiesAfterLogout.find((cookie) => cookie.name === "better-auth.session_token"),
    ).toBeUndefined();
  });
});
