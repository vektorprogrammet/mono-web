import { expect, test, type Page } from "@playwright/test";

/**
 * Live apex-preview smoke test. Every environment value comes from env —
 * no pinned IPs, no workstation paths:
 *   APEX_LIVE_E2E=1            enable (skipped otherwise)
 *   DASHBOARD_ORIGIN           e.g. https://vektor.phibkro.org
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE  optional chromium override
 */
const ADMIN = {
  email: process.env.APEX_ADMIN_EMAIL ?? "admin.apex@example.invalid",
  password: process.env.APEX_ADMIN_PASSWORD ?? "",
};

test.skip(process.env.APEX_LIVE_E2E !== "1", "live apex smoke only");
test.skip(ADMIN.password === "", "APEX_ADMIN_PASSWORD required");

test.setTimeout(120_000);

const signIn = async (page: Page) => {
  await page.goto("/login");
  await page.getByLabel("Brukernavn eller e-post").fill(ADMIN.email);
  await page.getByLabel("Passord", { exact: true }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  await page.waitForURL((url) => url.pathname.startsWith("/dashboard"), {
    timeout: 20_000,
    waitUntil: "commit",
  });
};

test("authenticated skoler mounts Foldkit; anonymous homepage is clean", async ({ browser }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  adminPage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  adminPage.on("pageerror", (e) => pageErrors.push(e.message));

  await signIn(adminPage);
  await adminPage.goto("/dashboard/skoler", { waitUntil: "load" });
  await expect(adminPage.locator("vektor-schools-directory")).toBeAttached();
  await expect(adminPage.getByRole("heading", { name: "Skoler", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const sessionCookie = (await adminContext.cookies()).find((c) =>
    c.name.endsWith("better-auth.session_token"),
  );
  expect(sessionCookie).toBeDefined();
  await adminContext.close();

  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();
  anonPage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  anonPage.on("pageerror", (e) => pageErrors.push(e.message));
  const response = await anonPage.goto("/", { waitUntil: "load", timeout: 30_000 });
  expect(response?.status()).toBe(200);
  expect((await anonPage.content()).length).toBeGreaterThan(5000);
  await anonContext.close();

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
