import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const systemChromium = "/etc/profiles/per-user/nori/bin/chromium-browser";
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync(systemChromium) ? systemChromium : undefined);
const w0Viewport = { width: 1440, height: 900 };
const genericDashboardOrigin = "http://127.0.0.1:5174";
const externalDashboardOrigin = process.env.DASHBOARD_ORIGIN ?? genericDashboardOrigin;
const realSymfonyCoreOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const realSymfonyCoreMode = process.env.REAL_SYMFONY_CORE_E2E === "1";
const realSymfonyRecruitmentMode = process.env.REAL_SYMFONY_RECRUITMENT_E2E === "1";
const realSymfonySchedulingMode = process.env.REAL_SYMFONY_INTERVIEW_SCHEDULING_E2E === "1";
const realSymfonyContentOpsMode = process.env.REAL_SYMFONY_CONTENT_OPS_E2E === "1";
const realSymfonyOrgOperationsMode = process.env.REAL_SYMFONY_ORG_OPERATIONS_E2E === "1";
const realSymfonyBackgroundOperationsMode =
  process.env.REAL_SYMFONY_BACKGROUND_OPERATIONS_E2E === "1";
const realReceiptOwnerMode = process.env.REAL_RECEIPT_OWNER_E2E === "1";
const realAdmissionPeriodMode = process.env.REAL_ADMISSION_PERIOD_E2E === "1";
const realNativeSchedulingMode = process.env.REAL_NATIVE_SCHEDULING_E2E === "1";
const realNativeInvitationResponseMode = process.env.REAL_NATIVE_INVITATION_RESPONSE_E2E === "1";
const realNativeOrganizationMode = process.env.REAL_NATIVE_ORGANIZATION_E2E === "1";
const realNativeIdentityMode = process.env.REAL_NATIVE_IDENTITY_E2E === "1";
const realSymfonyMode =
  realSymfonyCoreMode ||
  realSymfonyRecruitmentMode ||
  realSymfonySchedulingMode ||
  realSymfonyContentOpsMode ||
  realSymfonyOrgOperationsMode ||
  realSymfonyBackgroundOperationsMode;
const externalTopologyMode =
  realSymfonyMode ||
  realReceiptOwnerMode ||
  realAdmissionPeriodMode ||
  realNativeSchedulingMode ||
  realNativeInvitationResponseMode ||
  realNativeOrganizationMode ||
  realNativeIdentityMode;
const contentHomepageHost =
  realNativeIdentityMode && process.env.CONTENT_E2E_HOMEPAGE_ORIGIN !== undefined
    ? new URL(process.env.CONTENT_E2E_HOMEPAGE_ORIGIN).hostname
    : undefined;
const contentChromiumLaunchOptions = {
  ...(chromiumExecutablePath === undefined ? {} : { executablePath: chromiumExecutablePath }),
  ...(contentHomepageHost === undefined
    ? {}
    : { args: [`--host-resolver-rules=MAP ${contentHomepageHost} 127.0.0.1`] }),
};

const dashboardServer = {
  command: "bun run dev --host 127.0.0.1 --port 5174",
  url: genericDashboardOrigin,
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: "pipe" as const,
  gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
};

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/results",
  snapshotDir: "./e2e/snapshots",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: externalTopologyMode || process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL:
      realReceiptOwnerMode ||
      realAdmissionPeriodMode ||
      realNativeSchedulingMode ||
      realNativeInvitationResponseMode ||
      realNativeOrganizationMode ||
      realNativeIdentityMode
        ? externalDashboardOrigin
        : realSymfonyCoreMode
          ? realSymfonyCoreOrigin
          : realSymfonyMode
            ? externalDashboardOrigin
            : genericDashboardOrigin,
    trace: "off",
  },
  projects: realAdmissionPeriodMode
    ? [
        {
          name: "admission-period-management",
          use: {
            ...devices["Desktop Chrome"],
            viewport: w0Viewport,
            launchOptions: chromiumExecutablePath
              ? { executablePath: chromiumExecutablePath }
              : undefined,
          },
        },
      ]
    : realReceiptOwnerMode
      ? [
          {
            name: "receipt-owner",
            use: {
              ...devices["Desktop Chrome"],
              viewport: w0Viewport,
              launchOptions: chromiumExecutablePath
                ? { executablePath: chromiumExecutablePath }
                : undefined,
            },
          },
        ]
      : realSymfonyMode
        ? [
            {
              name: "real-symfony",
              use: {
                ...devices["Desktop Chrome"],
                viewport: w0Viewport,
                launchOptions: chromiumExecutablePath
                  ? { executablePath: chromiumExecutablePath }
                  : undefined,
              },
            },
          ]
        : [
            {
              name: "chromium",
              use: {
                ...devices["Desktop Chrome"],
                viewport: w0Viewport,
                launchOptions: contentChromiumLaunchOptions,
              },
            },
            {
              name: "firefox",
              use: { ...devices["Desktop Firefox"], viewport: w0Viewport },
            },
            {
              name: "webkit",
              use: { ...devices["Desktop Safari"], viewport: w0Viewport },
            },
          ],
  webServer: externalTopologyMode ? undefined : dashboardServer,
});
