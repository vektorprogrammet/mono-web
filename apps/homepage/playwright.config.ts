import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = 8787;
const localHost = "p000.vektor.phibkro.org";
const baseURL = `http://127.0.0.1:${port}`;
export const HOMEPAGE_PLAYWRIGHT_INPUTS = {
  origin: baseURL,
  host: localHost,
  stage: "p000",
  viewport: { width: 1440, height: 900 },
} as const;
const artifactRoot =
  process.env.PUBLIC_APPLICATION_PLAYWRIGHT_ARTIFACT_ROOT ??
  join(tmpdir(), "monoweb-homepage-dev-0011");
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const externallyManagedServer =
  process.env.REAL_PUBLIC_APPLICATION_E2E === "1";

export default defineConfig({
  timeout: 60_000,
  testDir: "./e2e",
  outputDir: join(artifactRoot, "playwright-results"),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: HOMEPAGE_PLAYWRIGHT_INPUTS.origin,
    viewport: HOMEPAGE_PLAYWRIGHT_INPUTS.viewport,
    locale: "nb-NO",
    timezoneId: "Europe/Oslo",
    serviceWorkers: "block",
    trace: "on",
    video: "on",
    screenshot: "on",
  },
  projects: [
    {
      name: "chromium",
      use: {
        launchOptions: {
          args: [`--host-resolver-rules=MAP ${localHost} 127.0.0.1`],
          ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
        },
      },
    },
  ],
  webServer: externallyManagedServer
    ? undefined
    : {
        port,
        cwd: "../..",
        command:
          "bun run --cwd apps/homepage worker:build && bun run --cwd apps/homepage worker:dev",
        reuseExistingServer: false,
        timeout: 180_000,
      },
});
