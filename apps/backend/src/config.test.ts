import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBackendConfig } from "./config.js";

const environment = {
  BACKEND_PG_URL: "postgres://test.invalid/config",
  BETTER_AUTH_SECRET: "synthetic-config-secret-with-at-least-32-characters",
  NATIVE_IDENTITY_DEPLOYMENT: "local",
  NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["http://127.0.0.1:4173"]),
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:4174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:4173",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
  PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
  PASSWORD_RESET_DELIVERY_MODE: "disabled",
  RECEIPT_DELIVERY_MODE: "disabled",
};

const httpEnvironment = {
  ...environment,
  PUBLIC_APPLICATION_EFFECT_MODE: "http",
  PUBLIC_APPLICATION_EFFECT_ENDPOINT: "https://provider.example.invalid/effects",
  PUBLIC_APPLICATION_EFFECT_TOKEN: "synthetic-provider-token",
};

afterEach(() => vi.unstubAllEnvs());

describe("backend configuration boundary", () => {
  it("requires explicit recovery modes and complete enabled providers before startup", () => {
    for (const key of ["PASSWORD_RESET_DELIVERY_MODE", "RECEIPT_DELIVERY_MODE"]) {
      expect(() => decodeBackendConfig({ ...environment, [key]: undefined })).toThrow();
      expect(() => decodeBackendConfig({ ...environment, [key]: "http" })).toThrow();
    }

    const reset = {
      ...environment,
      PASSWORD_RESET_DELIVERY_MODE: "http",
      MAIL_SENDER: "sender@example.invalid",
      MAIL_DELIVERY_URL: "http://127.0.0.1:9999/mail",
      MAIL_DELIVERY_TOKEN: "synthetic-token",
      MAIL_DELIVERY_TIMEOUT_MS: "1000",
    };

    for (const key of [
      "MAIL_SENDER",
      "MAIL_DELIVERY_URL",
      "MAIL_DELIVERY_TOKEN",
      "MAIL_DELIVERY_TIMEOUT_MS",
    ]) {
      expect(() => decodeBackendConfig({ ...reset, [key]: "" })).toThrow();
    }

    expect(() => decodeBackendConfig({ ...reset, PASSWORD_RESET_DELIVERY_POLL_MS: "0" })).toThrow();

    const receipt = {
      ...environment,
      RECEIPT_DELIVERY_MODE: "http",
      RECEIPT_DELIVERY_URL: "http://127.0.0.1:9999/receipt",
      RECEIPT_DELIVERY_TOKEN: "synthetic-token",
      RECEIPT_DELIVERY_TIMEOUT_MS: "1000",
      RECEIPT_DELIVERY_SENDER: "sender@example.invalid",
      RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: '{"department":"economy@example.invalid"}',
    };

    expect(() => decodeBackendConfig(receipt)).toThrow();
    expect(() =>
      decodeBackendConfig({
        ...receipt,
        RECEIPT_STAGING_ROOT: "/tmp/proof-staging",
        RECEIPT_COMMITTED_ROOT: "/tmp/proof-committed",
        RECEIPT_DELIVERY_POLL_MS: "-1",
      }),
    ).toThrow();
  });

  it("uses only the supplied record, including when required keys are missing", () => {
    vi.stubEnv("BACKEND_PG_URL", environment.BACKEND_PG_URL);
    vi.stubEnv("BACKEND_PORT", "9999");
    vi.stubEnv("OAUTH_CANONICAL_ORIGIN", environment.OAUTH_CANONICAL_ORIGIN);

    expect(() => decodeBackendConfig({ ...environment, BACKEND_PG_URL: undefined })).toThrow();
    expect(() =>
      decodeBackendConfig({ ...environment, OAUTH_CANONICAL_ORIGIN: undefined }),
    ).toThrow();
    expect(decodeBackendConfig(environment).port).toBe(8790);
    expect(decodeBackendConfig({ ...environment, BACKEND_PORT: "004321" }).port).toBe(4321);
  });

  it("defaults absent numbers but rejects blank, non-decimal and unsafe supplied numbers", () => {
    expect(
      decodeBackendConfig(httpEnvironment).publicApplicationEffects?.deliveryTimeoutMilliseconds,
    ).toBe(10_000);

    for (const raw of ["", " 1 ", "+1", "-1", "1.0", "1e3", "0", "9007199254740992"]) {
      expect(() => decodeBackendConfig({ ...environment, BACKEND_PORT: raw })).toThrow();
      expect(() =>
        decodeBackendConfig({ ...httpEnvironment, PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS: raw }),
      ).toThrow();
    }

    expect(() => decodeBackendConfig({ ...environment, BACKEND_PORT: "65536" })).toThrow();
    expect(decodeBackendConfig({ ...environment, BACKEND_PORT: "65535" }).port).toBe(65535);
    expect(
      decodeBackendConfig({ ...httpEnvironment, PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS: "0001" })
        .publicApplicationEffects?.deliveryTimeoutMilliseconds,
    ).toBe(1);
  });

  it("requires explicit delivery mode and forbids even empty credentials when disabled", () => {
    expect(() =>
      decodeBackendConfig({ ...environment, PUBLIC_APPLICATION_EFFECT_MODE: undefined }),
    ).toThrow();
    expect(() =>
      decodeBackendConfig({ ...environment, PUBLIC_APPLICATION_EFFECT_ENDPOINT: "" }),
    ).toThrow();
    expect(() =>
      decodeBackendConfig({ ...environment, PUBLIC_APPLICATION_EFFECT_TOKEN: "" }),
    ).toThrow();
    expect(() =>
      decodeBackendConfig({ ...httpEnvironment, PUBLIC_APPLICATION_EFFECT_TOKEN: "" }),
    ).toThrow();
    expect(() =>
      decodeBackendConfig({ ...httpEnvironment, PUBLIC_APPLICATION_EFFECT_ENDPOINT: undefined }),
    ).toThrow();
    expect(
      decodeBackendConfig({ ...environment, PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS: "inactive" })
        .publicApplicationEffects,
    ).toBeUndefined();
  });

  it("keeps HTTP delivery on loopback and rejects endpoint credentials", () => {
    expect(() =>
      decodeBackendConfig({
        ...httpEnvironment,
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "http://provider.example.invalid/effects",
      }),
    ).toThrow();
    expect(() =>
      decodeBackendConfig({
        ...httpEnvironment,
        PUBLIC_APPLICATION_EFFECT_ENDPOINT:
          "https://user:password@provider.example.invalid/effects",
      }),
    ).toThrow();
    expect(
      decodeBackendConfig({
        ...httpEnvironment,
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: "http://127.0.0.1:8898/effects?version=1#fragment",
      }).publicApplicationEffects?.endpoint.protocol,
    ).toBe("http:");
  });

  it("does not weaken loopback binding, deployment authority or derived secure cookies", () => {
    expect(() => decodeBackendConfig({ ...environment, BACKEND_HOST: "0.0.0.0" })).toThrow();
    expect(() => decodeBackendConfig({ ...environment, BACKEND_HOST: "" })).toThrow();
    expect(() =>
      decodeBackendConfig({ ...environment, NATIVE_IDENTITY_DEPLOYMENT: "production" }),
    ).toThrow();
    expect(() => decodeBackendConfig({ ...environment, BETTER_AUTH_URL: "" })).toThrow();
    expect(decodeBackendConfig(environment).auth.secureCookies).toBe(false);
    expect(
      decodeBackendConfig({
        ...environment,
        NATIVE_IDENTITY_DEPLOYMENT: "preview",
        NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["https://vektor.phibkro.org"]),
        OAUTH_DASHBOARD_ORIGIN: "https://vektor.phibkro.org",
      }).auth.secureCookies,
    ).toBe(true);
  });

  it("confines receipt E2E authority to an explicit local deployment", () => {
    const preview = {
      ...environment,
      NATIVE_IDENTITY_DEPLOYMENT: "preview",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: JSON.stringify(["https://vektor.phibkro.org"]),
      OAUTH_DASHBOARD_ORIGIN: "https://vektor.phibkro.org",
    };

    const failPromotion = { RECEIPT_E2E_FAIL_PROMOTION_EFFECT_ID: "receipt:PromoteReceiptFile" };

    expect(decodeBackendConfig(environment).receipt.e2e).toBeUndefined();
    expect(decodeBackendConfig(preview).receipt.e2e).toBeUndefined();
    expect(() => decodeBackendConfig({ ...preview, RECEIPT_E2E_TEST_MODE: "1" })).toThrow();
    expect(() => decodeBackendConfig({ ...preview, ...failPromotion })).toThrow();
    expect(() => decodeBackendConfig({ ...environment, ...failPromotion })).toThrow();
    expect(() => decodeBackendConfig({ ...environment, RECEIPT_E2E_TEST_MODE: "0" })).toThrow();
    expect(
      decodeBackendConfig({ ...environment, RECEIPT_E2E_TEST_MODE: "1", ...failPromotion }).receipt
        .e2e,
    ).toEqual({ failNextPromotionEffectId: "receipt:PromoteReceiptFile" });
  });

  it("does not reveal submitted secrets or credential-bearing URLs in errors", () => {
    const sentinel = "SYNTHETIC_PRIVATE_VALUE";

    const invalidConfigurations = [
      { ...environment, BETTER_AUTH_SECRET: sentinel },
      {
        ...httpEnvironment,
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: `https://user:${sentinel}@provider.example.invalid/effects`,
      },
      {
        ...httpEnvironment,
        PUBLIC_APPLICATION_EFFECT_ENDPOINT: `https://user:${sentinel}@[invalid`,
      },
      {
        ...httpEnvironment,
        BACKEND_PG_URL: `postgres://user:${sentinel}@test.invalid/config`,
        PUBLIC_APPLICATION_EFFECT_TOKEN: sentinel,
        PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS: sentinel,
      },
    ];

    for (const env of invalidConfigurations) {
      let failure: unknown;

      try {
        decodeBackendConfig(env);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeDefined();
      expect(String(failure)).not.toContain(sentinel);
      expect(JSON.stringify(failure)).not.toContain(sentinel);
      expect(inspect(failure, { depth: null })).not.toContain(sentinel);
    }
  });
});
