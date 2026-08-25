import { test } from "@playwright/test";
test.skip(process.env.APEX_LIVE_E2E !== "1");
const PW = process.env.APEX_ADMIN_PASSWORD ?? "apex-preview-admin-pass-2026";
for (let i = 1; i <= 10; i++) {
  test(`login.data probe ${i}`, async ({ page }) => {
    await page.goto("/login");
    const r = await page.evaluate(async (pw) => {
      const t0 = Date.now();
      try {
        const res = await fetch("/api/auth/sign-in/email", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "admin.apex@example.invalid", password: pw }),
        });
        return `ok ${res.status} ${Date.now() - t0}ms`;
      } catch (e) { return `ERR ${String(e).slice(0, 80)} ${Date.now() - t0}ms`; }
    }, PW);
    console.log(`PROBE${i}:${r}`);
  });
}
