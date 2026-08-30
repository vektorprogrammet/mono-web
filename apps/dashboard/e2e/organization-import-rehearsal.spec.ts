import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
};

const expectedDepartmentName = "Spec 0067 Department";
const expectedTeamName = "Spec 0067 Team";
const expectedMemberName = "Imported Member";
const expectedAdminName = "Spec Administrator";
const expectedMemberEmail = "imported-member.0067@example.invalid";
const expectedAdminEmail = "organization-import-admin.0067@example.invalid";

const sha256Text = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

if (process.env.ORGANIZATION_IMPORT_REHEARSAL === "1") {
  const dashboardOrigin = required("ORGANIZATION_IMPORT_REHEARSAL_DASHBOARD_ORIGIN");
  const apiOrigin = required("ORGANIZATION_IMPORT_REHEARSAL_API_ORIGIN");
  const sessionToken = required("ORGANIZATION_IMPORT_REHEARSAL_SESSION_TOKEN");
  const evidencePath = required("ORGANIZATION_IMPORT_REHEARSAL_BROWSER_EVIDENCE_PATH");
  const authorizationInstant = required("ORGANIZATION_IMPORT_REHEARSAL_AUTHORIZATION_INSTANT");
  test("renders the fresh native Organization projections without external requests", async ({
    browser,
  }) => {
    const allowedOrigins = new Set([dashboardOrigin, apiOrigin]);
    const requests: Array<{
      readonly method: string;
      readonly origin: "api-proxy-loopback";
      readonly path: string;
      readonly resourceType: string;
    }> = [];
    const rejectedDestinations: string[] = [];
    const pageErrors: string[] = [];
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.protocol === "data:" || url.protocol === "blob:") {
        await route.continue();
        return;
      }
      if (!allowedOrigins.has(url.origin)) {
        rejectedDestinations.push(url.origin);
        await route.abort("blockedbyclient");
        return;
      }
      if (url.origin === apiOrigin && url.pathname.startsWith("/api/")) {
        requests.push({
          method: request.method(),
          origin: "api-proxy-loopback",
          path: url.pathname,
          resourceType: request.resourceType(),
        });
      }
      await route.continue();
    });
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: sessionToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await page.goto(`${dashboardOrigin}/dashboard/team`, { waitUntil: "domcontentloaded" });
      const importedTeam = page.locator('[data-organization-id="6711"]');
      await expect(page.getByRole("heading", { name: "Registrerte team" })).toBeVisible();
      await expect(page.getByText("1 oppføring", { exact: true })).toBeVisible();
      await expect(importedTeam).toContainText(expectedTeamName);
      await expect(importedTeam).toContainText(expectedDepartmentName);
      await expect(importedTeam).toContainText("Aktiv");

      await page.goto(`${dashboardOrigin}/dashboard/brukere`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brukere" }).first()).toBeVisible();
      await expect(page.getByText(expectedMemberName, { exact: false })).toBeVisible();
      await expect(page.getByText(expectedDepartmentName, { exact: true })).toBeVisible();
      await expect(page.getByText(expectedMemberEmail, { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Inaktive Brukere" }).click();
      await expect(page.getByText(expectedAdminName, { exact: false })).toBeVisible();
      await expect(page.getByText(expectedAdminEmail, { exact: true })).toBeVisible();
      const legacyOrganizationRequests = requests.filter(({ path }) =>
        /legacy|php|graphql/iu.test(path),
      ).length;
      expect(pageErrors).toEqual([]);
      expect(legacyOrganizationRequests).toBe(0);
      expect(rejectedDestinations).toEqual([]);
      await writeFile(
        evidencePath,
        `${JSON.stringify({
          authorizationInstant,
          pages: [
            {
              path: "/dashboard/team",
              observed: [expectedDepartmentName, expectedTeamName],
            },
            {
              path: "/dashboard/brukere",
              observed: [expectedMemberName, expectedAdminName, expectedDepartmentName],
              contactSha256: [
                sha256Text(expectedMemberEmail),
                sha256Text(expectedAdminEmail),
              ].sort(),
            },
          ],
          pageErrors,
          legacyOrganizationRequests,
          rejectedDestinations,
          requests,
          status: "Observed",
        })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    } finally {
      await context.close();
    }
  });
}
