import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

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
const expectedMemberPhone = "+4700006731";
const expectedAdminPhone = "+4700000067";

const sha256Text = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const maximumDiagnosticEntries = 128;
const maximumDiagnosticTextLength = 2_000;

type DiagnosticOrigin = "dashboard-loopback" | "api-proxy-loopback";

interface DiagnosticElementState {
  readonly connected: boolean;
  readonly childCount: number;
}

interface DiagnosticFinalPageState {
  readonly path: string;
  readonly customElementDefined: boolean;
  readonly host: DiagnosticElementState;
  readonly container: DiagnosticElementState;
  readonly headings: ReadonlyArray<string>;
}

const redactDiagnosticText = (value: string, sensitiveValues: ReadonlyArray<string>): string => {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) redacted = redacted.replaceAll(sensitive, "<redacted>");
  }
  redacted = redacted.replace(
    /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu,
    "<redacted-contact>",
  );
  return redacted.slice(0, maximumDiagnosticTextLength);
};

const appendDiagnostic = <Value>(target: Value[], value: Value): void => {
  if (target.length < maximumDiagnosticEntries) target.push(value);
};

const readFinalPageState = async (
  page: Page | undefined,
  sensitiveValues: ReadonlyArray<string>,
): Promise<DiagnosticFinalPageState> => {
  let path = "";
  if (page !== undefined) {
    try {
      path = new URL(page.url()).pathname;
    } catch {
      path = "";
    }
  }
  const fallback = {
    path: redactDiagnosticText(path, sensitiveValues),
    customElementDefined: false,
    host: { connected: false, childCount: 0 },
    container: { connected: false, childCount: 0 },
    headings: [],
  } satisfies DiagnosticFinalPageState;
  if (page === undefined) return fallback;
  try {
    const host = page.locator("vektor-organization-catalog").first();
    const container = host.locator("#foldkit-organization-catalog").first();
    const [
      customElementDefined,
      hostCount,
      hostChildCount,
      containerCount,
      containerChildCount,
      headings,
    ] = await Promise.all([
      page.evaluate(() => customElements.get("vektor-organization-catalog") !== undefined),
      host.count(),
      host.locator(":scope > *").count(),
      container.count(),
      container.locator(":scope > *").count(),
      page.locator("h1, h2, h3, h4, h5, h6").evaluateAll(
        (nodes, maximumEntries) =>
          nodes
            .slice(0, maximumEntries)
            .map((heading) => heading.textContent?.trim() ?? "")
            .filter((heading) => heading.length > 0),
        maximumDiagnosticEntries,
      ),
    ]);
    return {
      path: fallback.path,
      customElementDefined,
      host: {
        connected: hostCount > 0,
        childCount: Math.min(hostChildCount, 10_000),
      },
      container: {
        connected: containerCount > 0,
        childCount: Math.min(containerChildCount, 10_000),
      },
      headings: headings.map((heading) => redactDiagnosticText(heading, sensitiveValues)),
    };
  } catch {
    return fallback;
  }
};

if (process.env.ORGANIZATION_IMPORT_REHEARSAL === "1") {
  const dashboardOrigin = required("ORGANIZATION_IMPORT_REHEARSAL_DASHBOARD_ORIGIN");
  const apiOrigin = required("ORGANIZATION_IMPORT_REHEARSAL_API_ORIGIN");
  const sessionToken = required("ORGANIZATION_IMPORT_REHEARSAL_SESSION_TOKEN");
  const evidencePath = required("ORGANIZATION_IMPORT_REHEARSAL_BROWSER_EVIDENCE_PATH");
  const authorizationInstant = required("ORGANIZATION_IMPORT_REHEARSAL_AUTHORIZATION_INSTANT");
  const nativeApiPathInput: unknown = JSON.parse(
    required("ORGANIZATION_IMPORT_REHEARSAL_NATIVE_API_PATHS"),
  );
  if (
    !Array.isArray(nativeApiPathInput) ||
    nativeApiPathInput.some((path) => typeof path !== "string")
  ) {
    throw new Error("ORGANIZATION_IMPORT_REHEARSAL_NATIVE_API_PATHS must be a string array");
  }
  const nativeApiPaths = new Set<string>(nativeApiPathInput);
  test("renders the fresh native Organization projections without external requests", async ({
    browserName,
    playwright,
  }, testInfo) => {
    const allowedOrigins: Record<string, true> = {
      [dashboardOrigin]: true,
      [apiOrigin]: true,
    };
    const diagnosticSensitiveValues = [
      sessionToken,
      expectedMemberEmail,
      expectedAdminEmail,
      expectedMemberPhone,
      expectedAdminPhone,
    ] as const;
    const requests: Array<{
      readonly method: string;
      readonly origin: "api-proxy-loopback";
      readonly path: string;
      readonly resourceType: string;
    }> = [];
    const diagnosticRequests: Array<{
      readonly method: string;
      readonly origin: DiagnosticOrigin;
      readonly path: string;
      readonly resourceType: string;
    }> = [];
    const failedResponses: Array<{
      readonly origin: DiagnosticOrigin;
      readonly path: string;
      readonly status: number;
    }> = [];
    const rejectedDestinations: string[] = [];
    const unexpectedApiRequests: Array<{
      readonly method: string;
      readonly path: string;
    }> = [];
    const pageErrors: string[] = [];
    const consoleMessages: Array<{
      readonly type: string;
      readonly text: string;
    }> = [];
    let ownedBrowser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let failed = false;
    let testFailure: unknown;
    let evidenceWriteFailed = false;
    let evidenceWriteFailure: unknown;
    try {
      ownedBrowser = await playwright[browserName].launch(testInfo.project.use.launchOptions);
      context = await ownedBrowser.newContext();
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.protocol === "data:" || url.protocol === "blob:") {
          await route.continue();
          return;
        }
        if (allowedOrigins[url.origin] !== true) {
          appendDiagnostic(
            rejectedDestinations,
            redactDiagnosticText(url.origin, diagnosticSensitiveValues),
          );
          await route.abort("blockedbyclient");
          return;
        }
        const diagnosticOrigin: DiagnosticOrigin =
          url.origin === dashboardOrigin ? "dashboard-loopback" : "api-proxy-loopback";
        appendDiagnostic(diagnosticRequests, {
          method: redactDiagnosticText(request.method(), diagnosticSensitiveValues),
          origin: diagnosticOrigin,
          path: redactDiagnosticText(url.pathname, diagnosticSensitiveValues),
          resourceType: redactDiagnosticText(request.resourceType(), diagnosticSensitiveValues),
        });
        if (url.origin === apiOrigin) {
          const observation = {
            method: request.method(),
            origin: "api-proxy-loopback" as const,
            path: url.pathname,
            resourceType: request.resourceType(),
          };
          requests.push(observation);
          if (!nativeApiPaths.has(url.pathname) || request.method() !== "GET") {
            appendDiagnostic(unexpectedApiRequests, {
              method: redactDiagnosticText(request.method(), diagnosticSensitiveValues),
              path: redactDiagnosticText(url.pathname, diagnosticSensitiveValues),
            });
            await route.abort("blockedbyclient");
            return;
          }
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

      page = await context.newPage();
      page.on("pageerror", (error) =>
        appendDiagnostic(
          pageErrors,
          redactDiagnosticText(error.message, diagnosticSensitiveValues),
        ),
      );
      page.on("console", (message) =>
        appendDiagnostic(consoleMessages, {
          type: redactDiagnosticText(message.type(), diagnosticSensitiveValues),
          text: redactDiagnosticText(message.text(), diagnosticSensitiveValues),
        }),
      );
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (allowedOrigins[url.origin] !== true || response.status() < 400) return;
        appendDiagnostic(failedResponses, {
          origin: url.origin === dashboardOrigin ? "dashboard-loopback" : "api-proxy-loopback",
          path: redactDiagnosticText(url.pathname, diagnosticSensitiveValues),
          status: response.status(),
        });
      });

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
      expect(unexpectedApiRequests).toEqual([]);
    } catch (cause) {
      failed = true;
      testFailure = cause;
    } finally {
      const finalPageState = await readFinalPageState(page, diagnosticSensitiveValues);
      if (context !== undefined) {
        try {
          await context.close();
        } catch (cause) {
          if (!failed) {
            failed = true;
            testFailure = cause;
          }
        }
      }
      if (ownedBrowser !== undefined) {
        try {
          await ownedBrowser.close();
        } catch (cause) {
          if (!failed) {
            failed = true;
            testFailure = cause;
          }
        }
      }
      const legacyOrganizationRequests = requests.filter(({ path }) =>
        /legacy|php|graphql/iu.test(path),
      ).length;
      const evidence = failed
        ? {
            status: "Failed",
            failure: redactDiagnosticText(
              testFailure instanceof Error ? testFailure.message : String(testFailure),
              diagnosticSensitiveValues,
            ),
            pageErrors,
            consoleMessages,
            rejectedDestinations,
            unexpectedApiRequests,
            requests: diagnosticRequests,
            failedResponses,
            finalPageState,
          }
        : {
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
            unexpectedApiRequests,
            requests,
            status: "Observed",
          };
      try {
        await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (cause) {
        evidenceWriteFailed = true;
        evidenceWriteFailure = cause;
      }
    }
    if (failed) throw testFailure;
    if (evidenceWriteFailed) throw evidenceWriteFailure;
  });
}
