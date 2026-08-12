import { expect, test } from "@playwright/test";
import contract from "../../../infra/preview/routes/route-contract.json";

const baseURL = process.env.PREVIEW_BASE_URL ?? "https://p20.vektor.phibkro.org";
const forbiddenHost = "vektorprogrammet.no";

test.describe("p20 preview route contract", () => {
  for (const route of contract.routes) {
    test(`${route.application} ${route.path}`, async ({ page }, testInfo) => {
      const forbiddenRequests: string[] = [];
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes(forbiddenHost)) forbiddenRequests.push("forbidden-host");
      });
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const response = await page.goto(new URL(route.path, baseURL).toString(), { waitUntil: "networkidle" });
      expect(response?.status()).toBe(route.expectedStatus);
      expect(response?.url()).toContain(new URL(route.path, baseURL).pathname);
      await expect(page.locator("body")).not.toBeEmpty();
      expect(forbiddenRequests).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
      if (route.visualEvidence) {
        await page.screenshot({ path: testInfo.outputPath(`${route.application}-${route.path.replaceAll("/", "_") || "root"}.png`), fullPage: true });
      }
    });
  }
});
