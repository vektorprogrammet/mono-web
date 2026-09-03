import { describe, expect, it } from "vitest";
import {
  assertDisposablePostgresUrl,
  departmentEntityIdFor,
  makePreviewScenarioEnvironment,
} from "./preview-scenario";

describe("representative preview scenario", () => {
  it("derives the same native department identifier as Organization administration", () => {
    expect(departmentEntityIdFor("preview-0072-dept-ntnu-cmd")).toBe(
      "department-1fb4bbbfbcd6ce8960504c4b22ce84f0b6dd7c579de91f6b3858347991fa0177",
    );
  });

  it("composes the exact dev-main identity policy without legacy aliases", () => {
    const environment = makePreviewScenarioEnvironment({
      PREVIEW_SCENARIO_TEST_MARKER: "retained",
      BETTER_AUTH_URL: "",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://legacy.example.invalid",
    });

    expect(environment).toMatchObject({
      PREVIEW_SCENARIO_TEST_MARKER: "retained",
      NATIVE_IDENTITY_DEPLOYMENT: "preview",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: '["https://vektor.phibkro.org"]',
      OAUTH_CANONICAL_ORIGIN: "https://vektor.phibkro.org",
      OAUTH_DASHBOARD_ORIGIN: "https://vektor.phibkro.org",
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    });
    expect(environment).not.toHaveProperty("BETTER_AUTH_URL");
    expect(environment).not.toHaveProperty("BETTER_AUTH_TRUSTED_ORIGINS");
  });

  it.each([
    "postgres://postgres@127.0.0.1:5435/preview_scenario",
    "postgresql://postgres@localhost:5435/scenario_test",
  ])("accepts disposable loopback PostgreSQL: %s", (url) => {
    expect(() => assertDisposablePostgresUrl(url)).not.toThrow();
  });

  it.each([
    "https://127.0.0.1/preview_scenario",
    "postgres://postgres@database.internal/preview_scenario",
    "postgres://postgres@127.0.0.1:5434/preview_scenario",
    "postgres://postgres@127.0.0.1:5435/postgres",
    "postgres://postgres@vektorprogrammet.no/preview_scenario",
  ])("rejects a non-disposable database target: %s", (url) => {
    expect(() => assertDisposablePostgresUrl(url)).toThrow();
  });
});
