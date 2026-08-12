import { expect, test } from "@playwright/test";
import contract from "../../../infra/preview/routes/route-contract.json";

const baseURL = process.env.PREVIEW_BASE_URL ?? "https://p20.vektor.phibkro.org";
const forbiddenHost = "vektorprogrammet.no";

function screenshotId(routeId: string): string {
  return routeId.replace(/[^A-Za-z0-9._-]/g, "_");
}

test.describe("p20 preview route contract", () => {
  for (const route of contract.routes) {
    test(`${route.app} ${route.path}`, async ({ page }, testInfo) => {
      const forbiddenRequests: string[] = [];
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const url = new URL(route.path, baseURL).toString();
      page.on("request", (request) => {
        if (request.url().includes(forbiddenHost)) forbiddenRequests.push("forbidden-host");
      });
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const initialResponse = await page.request.get(url, { maxRedirects: 0 });
      expect(initialResponse.status()).toBe(route.expected.status);
      if (route.expected.redirectTo) {
        const location = initialResponse.headers().location;
        expect(location).toBeDefined();
        expect(new URL(location!, url).pathname).toBe(route.expected.redirectTo);
      }

      const response = await page.goto(url, { waitUntil: "networkidle" });
      if (route.expected.status < 300) {
        expect(response?.status()).toBe(route.expected.status);
        expect(response?.url()).toContain(new URL(route.path, baseURL).pathname);
      } else {
        expect(response?.status()).toBeGreaterThanOrEqual(200);
        expect(new URL(response!.url()).pathname).toBe(route.expected.redirectTo);
      }

      const body = await page.locator("body").innerText();
      expect(body.trim()).not.toBe("");
      if (route.expected.basicState === "authorization-denied") {
        expect(initialResponse.status()).toBe(302);
      } else if (route.expected.basicState === "not-found") {
        expect(initialResponse.status()).toBe(404);
      } else if (route.expected.basicState === "validation-safe") {
        expect(initialResponse.status()).toBe(200);
      }
      expect(forbiddenRequests).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);

      const id = screenshotId(route.id);
      if (route.visual.desktop) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.screenshot({ path: testInfo.outputPath(`${id}-desktop.png`), fullPage: true });
      }
      if (route.visual.mobile) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: testInfo.outputPath(`${id}-mobile.png`), fullPage: true });
      }
    });
  }
});
