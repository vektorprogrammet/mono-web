import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const systemChromium = '/etc/profiles/per-user/nori/bin/chromium-browser';
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync(systemChromium) ? systemChromium : undefined);
const w0Viewport = { width: 1440, height: 900 };
const genericDashboardOrigin = 'http://127.0.0.1:5174';
const interviewDashboardOrigin = 'http://127.0.0.1:5173';
const interviewApiUrl = 'http://127.0.0.1:8790';
const realSymfonyDashboardOrigin =
  process.env.DASHBOARD_ORIGIN ?? genericDashboardOrigin;
const apiMode = process.env.API_MODE;
const viteApiMode = process.env.VITE_API_MODE;
const fixtureMode =
  apiMode === 'fixture' && viteApiMode === 'fixture';
const realSymfonyMode =
  process.env.REAL_SYMFONY_RECRUITMENT_E2E === '1' ||
  process.argv.some((argument) =>
    argument.endsWith('real-symfony-recruitment.spec.ts'),
  );
const interviewMode =
  process.env.FOLDKIT_INTERVIEW_E2E === '1' ||
  process.argv.some((argument) => argument.endsWith('foldkit-interview.spec.ts'));

const interviewControlKey =
  process.env.INTERVIEW_FIXTURE_CONTROL_KEY ??
  'foldkit-interview-control-key-0021-local-only';
const interviewEnv = {
  ...process.env,
  API_MODE: 'fixture',
  VITE_API_MODE: 'fixture',
  API_URL: interviewApiUrl,
  VITE_API_URL: interviewApiUrl,
  DASHBOARD_ORIGIN: interviewDashboardOrigin,
  VITE_DASHBOARD_ORIGIN: interviewDashboardOrigin,
  DASHBOARD_INTERVIEW_OWNER: 'foldkit',
  VITE_DASHBOARD_INTERVIEW_OWNER: 'foldkit',
  INTERVIEW_FIXTURE_CONTROL_KEY: interviewControlKey,
  ALCHEMY_CLOUDFLARE_VITE_INJECTED: '1',
};

const fixtureServer = {
  command: 'node e2e/fixtures/login-api.mjs',
  url: 'http://127.0.0.1:8788/health',
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: 'pipe' as const,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
};
const interviewFixtureServer = {
  command: 'bun e2e/fixtures/interview-api.ts --port 8790',
  url: `${interviewApiUrl}/__interview_fixture/health`,
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: 'pipe' as const,
  env: interviewEnv,
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
const interviewDashboardServer = {
  command: 'bun run build && bun run start',
  url: `${interviewDashboardOrigin}/dashboard`,
  timeout: 120_000,
  reuseExistingServer: false,
  stdout: 'pipe' as const,
  env: {
    ...interviewEnv,
    HOST: '127.0.0.1',
    PORT: '5173',
  },
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
  workers:
    realSymfonyMode || interviewMode || fixtureMode || process.env.CI
      ? 1
      : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL: realSymfonyMode
      ? realSymfonyDashboardOrigin
      : interviewMode
        ? interviewDashboardOrigin
        : genericDashboardOrigin,
    /* Traces can capture request headers and server-held capabilities. */
    trace: 'off',

  },

  /* Configure projects for major browsers */
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
    : interviewMode
      ? [
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

  /* Run the selected local fixture and dashboard before the tests. */
  webServer: realSymfonyMode
    ? undefined
    : interviewMode
      ? [interviewFixtureServer, interviewDashboardServer]
      : fixtureMode
        ? [fixtureServer, dashboardServer]
        : dashboardServer,
});
