import { describe, expect, it } from "vitest";
import { recruitmentNotificationConfig } from "./delivery.js";

describe("recruitment delivery claim lease", () => {
  it("rejects a lease that can expire before an HTTP attempt finishes", () => {
    const configuration = {
      RECRUITMENT_NOTIFICATION_MODE: "http",
      RECRUITMENT_NOTIFICATION_URL: "http://127.0.0.1:8900/notifications",
      RECRUITMENT_NOTIFICATION_TOKEN: "synthetic-regression-token",
      RECRUITMENT_NOTIFICATION_TIMEOUT_MS: "10000",
    };

    expect(() =>
      recruitmentNotificationConfig({
        ...configuration,
        RECRUITMENT_NOTIFICATION_STALE_MS: "10000",
      }),
    ).toThrow();
    expect(
      recruitmentNotificationConfig({
        ...configuration,
        RECRUITMENT_NOTIFICATION_STALE_MS: "10001",
      }),
    ).toBeDefined();
  });
});
