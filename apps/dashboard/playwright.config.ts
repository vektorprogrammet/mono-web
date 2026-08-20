import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const systemChromium = '/etc/profiles/per-user/nori/bin/chromium-browser';
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync(systemChromium) ? systemChromium : undefined);
const w0Viewport = { width: 1440, height: 900 };
const genericDashboardOrigin = 'http://127.0.0.1:5174';
const realSymfonyDashboardOrigin =
  process.env.DASHBOARD_ORIGIN ?? genericDashboardOrigin;
const apiMode = process.env.API_MODE;
const viteApiMode = process.env.VITE_API_MODE;
const fixtureMode =
  apiMode === 'fixture' && viteApiMode === 'fixture';
const realSymfonyRecruitmentMode =
  process.env.REAL_SYMFONY_RECRUITMENT_E2E === '1';
const realSymfonySchedulingMode =
  process.env.REAL_SYMFONY_INTERVIEW_SCHEDULING_E2E === '1';
const realSymfonyMode =
  realSymfonyRecruitmentMode || realSymfonySchedulingMode;

const fixtureServer = {
  command: 'node e2e/fixtures/login-api.mjs',
  url: 'http://127.0.0.1:8788/health',
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: 'pipe' as const,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
};
const dashboardServer = {
  command: 'bun run dev --host 127.0.0.1 --port 5174',
  url: genericDashboardOrigin,
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: 'pipe' as const,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
};

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/results',
  snapshotDir: './e2e/snapshots',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers:
    realSymfonyMode || fixtureMode || process.env.CI
      ? 1
      : undefined,
  reporter: 'html',
  use: {
    baseURL: realSymfonyMode
      ? realSymfonyDashboardOrigin
      : genericDashboardOrigin,
    trace: 'off',
  },
  projects: realSymfonyMode
    ? [
      {
        name: 'real-symfony',
        use: {
          ...devices['Desktop Chrome'],
          viewport: w0Viewport,
          launchOptions: chromiumExecutablePath
            ? { executablePath: chromiumExecutablePath }
            : undefined,
        },
      },
    ]
    : [
      {
        name: 'chromium',
        use: {
          ...devices['Desktop Chrome'],
          viewport: w0Viewport,
          launchOptions: chromiumExecutablePath
            ? { executablePath: chromiumExecutablePath }
            : undefined,
        },
      },
      {
        name: 'firefox',
        use: { ...devices['Desktop Firefox'], viewport: w0Viewport },
      },
      {
        name: 'webkit',
        use: { ...devices['Desktop Safari'], viewport: w0Viewport },
      },
    ],
  webServer: realSymfonyMode
    ? undefined
    : fixtureMode
      ? [fixtureServer, dashboardServer]
      : dashboardServer,
});
