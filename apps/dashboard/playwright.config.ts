import { defineConfig, devices } from '@playwright/test';

const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const w0Viewport = { width: 1440, height: 900 };
const apiMode = process.env.API_MODE;
const viteApiMode = process.env.VITE_API_MODE;
const fixtureMode =
  apiMode === 'fixture' && viteApiMode === 'fixture';

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
  url: 'http://127.0.0.1:5174',
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: 'pipe' as const,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
};

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/results',
  snapshotDir: './e2e/snapshots',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: fixtureMode || process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://127.0.0.1:5174',
    viewport: w0Viewport,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
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

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: fixtureMode
    ? [fixtureServer, dashboardServer]
    : dashboardServer,
});
