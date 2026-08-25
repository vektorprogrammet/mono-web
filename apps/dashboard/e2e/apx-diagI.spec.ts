import { test, expect } from "@playwright/test";
test.skip(process.env.APEX_LIVE_E2E !== "1");
test("journey with console capture", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", e => pageErrors.push(e.message.slice(0, 160)));
  await page.goto("/login");
  await page.evaluate(async () => {
    await fetch("/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin.apex@example.invalid", password: "apex-preview-admin-pass-2026" }),
    });
  });
  await page.goto("/dashboard/skoler", { waitUntil: "load" });
  await page.waitForTimeout(4000);
  console.log("EL:" + await page.locator("vektor-schools-directory").count());
  console.log("HEAD:" + await page.getByRole("heading", { name: "Skoler" }).count());
  console.log("CERR:" + JSON.stringify(consoleErrors));
  console.log("PERR:" + JSON.stringify(pageErrors));
});
