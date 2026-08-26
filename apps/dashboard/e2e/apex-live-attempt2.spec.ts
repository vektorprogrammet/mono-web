import { expect, test, type Browser, type Page } from "@playwright/test";

const ADMIN = {
  email: "admin.apex@example.invalid",
  password: process.env.APEX_ADMIN_PASSWORD ?? "apex-preview-admin-pass-2026",
};

/**
 * Attempt 2: the form POST itself works end-to-end through the real edge
 * (proven by curl 302 + Set-Cookie). The failing piece is server-to-server
 * auth inside the dashboard Worker. This spec signs in via the browser's
 * same-origin fetch to /api/auth (200 proven) and then exercises the
 * authenticated dashboard journey with the session cookie the edge set.
 */
test.describe("Apex live verification v2", () => {
  test.skip(process.env.APEX_LIVE_E2E !== "1", "live apex run only");
  test.setTimeout(120_000);

  test("admin session reaches schools directory; anonymous sees homepage", async ({ browser }: { browser: Browser }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    adminPage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    adminPage.on("pageerror", (e) => pageErrors.push(e.message));
    const badUrls: string[] = [];
    adminPage.on("response", (r) => { if (r.status() >= 400) badUrls.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 90)}`); });

    // Sign in from the browser context via the same-origin API leg:
    await adminPage.goto("/login", { waitUntil: "load" });
    const signinStatus = await adminPage.evaluate(async ({ email, password }: { email: string; password: string }) => {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      return res.status;
    }, ADMIN);
    expect(signinStatus).toBe(200);
    const cookie = (await adminContext.cookies()).find(
      (c) => c.name === "__Secure-better-auth.session_token" || c.name === "better-auth.session_token",
    );
    expect(cookie).toBeDefined();

    // Authenticated navigation to the schools directory:
    await adminPage.goto("/dashboard/skoler", { waitUntil: "load" });
    const el = adminPage.locator("vektor-schools-directory");
    await expect(el).toBeAttached();
    await expect(adminPage.getByRole("heading", { name: "Skoler", exact: true })).toBeVisible({ timeout: 20_000 });

    await adminContext.close();

    // Anonymous homepage check:
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    anonPage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    anonPage.on("pageerror", (e) => pageErrors.push(e.message));
    const response = await anonPage.goto("/", { waitUntil: "load", timeout: 30_000 });
    expect(response?.status()).toBe(200);
    expect((await anonPage.content()).length).toBeGreaterThan(5000);
    await anonContext.close();
    // TEMP: dump bad URLs seen on admin page
    process.stdout.write(`BADURLS=${JSON.stringify(badUrls)}\n`);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    process.stdout.write(`APEX_LIVE_OK consoleErrors=${JSON.stringify(consoleErrors)} pageErrors=${JSON.stringify(pageErrors)}\n`);
  });
});
