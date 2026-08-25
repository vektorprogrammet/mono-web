import { expect, test, type Browser, type Page } from "@playwright/test";

const ADMIN = {
  email: "admin.apex@example.invalid",
  password: process.env.APEX_ADMIN_PASSWORD ?? "apex-preview-admin-pass-2026",
};

const signIn = async (page: Page, redirectTo: string) => {
  await page.goto(`/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel("Brukernavn eller e-post").fill(ADMIN.email);
  await page.getByLabel("Passord", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  // The app may redirect to /dashboard first (safeRedirect fallback when the
  // hydrated client action drops the query param); accept any authenticated
  // dashboard navigation, then go to the target route explicitly.
  try {
    await page.waitForURL((url) => url.pathname === redirectTo, { timeout: 10_000, waitUntil: "commit" });
  } catch {
    await page.waitForURL((url) => url.pathname.startsWith("/dashboard"), { timeout: 10_000, waitUntil: "commit" });
    if (redirectTo !== "/dashboard") await page.goto(redirectTo, { waitUntil: "load" });
  }
  await expect
    .poll(async () =>
      (await page.context().cookies()).some(
        (cookie) => cookie.name === "better-auth.session_token" || cookie.name === "__Secure-better-auth.session_token",
      ),
    )
    .toBe(true);
};

test.describe("Apex live verification", () => {
  test.skip(process.env.APEX_LIVE_E2E !== "1", "live apex run only");
  test.setTimeout(120_000);

  test("admin signs in and sees the schools directory; anonymous sees homepage", async ({ browser }: { browser: Browser }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    adminPage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    adminPage.on("pageerror", (e) => pageErrors.push(e.message));

    await signIn(adminPage, "/dashboard/skoler");
    const el = adminPage.locator("vektor-schools-directory");
    await expect(el).toBeAttached();
    await expect(adminPage.getByRole("heading", { name: "Skoler", exact: true })).toBeVisible({ timeout: 20_000 });

    const sessionCookie = (await adminContext.cookies()).find(
      (c) => c.name === "__Secure-better-auth.session_token" || c.name === "better-auth.session_token",
    );
    expect(sessionCookie).toBeDefined();

    await adminContext.close();

    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    anonPage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    anonPage.on("pageerror", (e) => pageErrors.push(e.message));
    const response = await anonPage.goto("/", { waitUntil: "load", timeout: 30_000 });
    expect(response?.status()).toBe(200);
    const html = await anonPage.content();
    expect(html.length).toBeGreaterThan(5000);
    await anonContext.close();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    process.stdout.write(`APEX_LIVE_OK consoleErrors=${JSON.stringify(consoleErrors)} pageErrors=${JSON.stringify(pageErrors)}\n`);
  });
});
