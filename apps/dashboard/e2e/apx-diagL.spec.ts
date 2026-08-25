import { test } from "@playwright/test";
test.skip(process.env.APEX_LIVE_E2E !== "1");
test("module fetch with browser headers", async ({ page }) => {
  const bad: string[] = [];
  page.on("response", r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url().slice(0,80)} dest=${r.headers()["sec-fetch-dest"] ?? "?"} ref=${(r.headers()["referer"] ?? "none").slice(0,40)}`); });
  await page.goto("/login");
  await page.locator("#username").fill("admin.apex@example.invalid");
  await page.locator("#password").fill(process.env.APEX_ADMIN_PASSWORD ?? "apex-preview-admin-pass-2026");
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  await page.waitForTimeout(3000);
  await page.goto("/dashboard/skoler", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  console.log("BAD:" + JSON.stringify(bad, null, 1).slice(0, 800));
});
