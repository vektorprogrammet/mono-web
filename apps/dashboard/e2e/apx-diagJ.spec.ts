import { test } from "@playwright/test";
test.skip(process.env.APEX_LIVE_E2E !== "1");
test("which 404 remains", async ({ page }) => {
  const bad: string[] = [];
  page.on("response", r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  await page.goto("/login");
  await page.evaluate(async () => {
    await fetch("/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin.apex@example.invalid", password: "apex-preview-admin-pass-2026" }),
    });
  });
  bad.length = 0;
  await page.goto("/dashboard/skoler", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  console.log("BAD:" + JSON.stringify(bad, null, 1));
});
