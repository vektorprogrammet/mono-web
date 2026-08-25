import { test, expect } from "@playwright/test";
test.skip(process.env.APEX_LIVE_E2E !== "1");
test("locate the intermittent 404", async ({ page }) => {
  const consoleErrors: string[] = [];
  const bad: string[] = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 120)); });
  page.on("response", r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url().slice(0, 90)}`); });
  await page.goto("/login");
  await page.evaluate(async () => {
    await fetch("/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin.apex@example.invalid", password: "apex-preview-admin-pass-2026" }),
    });
  });
  await page.goto("/dashboard/skoler", { waitUntil: "load" });
  // The earlier failing run showed a favicon-ish or late asset; wait longer
  await page.waitForTimeout(5000);
  console.log("BAD:" + JSON.stringify(bad));
  console.log("CERR:" + JSON.stringify(consoleErrors));
});
