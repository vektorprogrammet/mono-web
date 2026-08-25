import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const systemChromium = "/etc/profiles/per-user/nori/bin/chromium-browser";
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  (existsSync(systemChromium) ? systemChromium : undefined);
const w0Viewport = { width: 1440, height: 900 };
const externalDashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "https://vektor.phibkro.org";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: externalDashboardOrigin,
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: w0Viewport,
        launchOptions: chromiumExecutablePath
          ? {
              executablePath: chromiumExecutablePath,
              // This workstation has no IPv6 route; Chromium's async DNS
              // otherwise prefers the record's AAAA answers and fails with
              // ERR_ADDRESS_UNREACHABLE before any request leaves the host.
              args: [
                "--host-resolver-rules=MAP vektor.phibkro.org 172.67.220.231,MAP api.vektor.phibkro.org 104.21.94.75,MAP p20.vektor.phibkro.org 104.21.94.75",
                "--disable-ipv6",
              ],
            }
          : undefined,
      },
    },
  ],
  webServer: undefined,
});
