import { describe, expect, it } from "vitest";
import { decodeOAuthBackendConfig } from "./config.js";

const localEnvironment = {
  OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1:4174",
  OAUTH_DASHBOARD_ORIGIN: "http://127.0.0.1:4173",
  OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
} as const;

describe("OAuth backend configuration", () => {
  it("decodes one exact issuer origin, dashboard origin, and native resource", () => {
    expect(decodeOAuthBackendConfig(localEnvironment, ["http://127.0.0.1:4173"])).toEqual({
      oauth: {
        canonicalOrigin: "http://127.0.0.1:4174",
        dashboardOrigin: "http://127.0.0.1:4173",
        nativeApiResource: "urn:vektorprogrammet:native-api",
      },
      internalSourceNetworks: [],
    });
  });

  it.each([
    ["issuer trailing slash", { OAUTH_CANONICAL_ORIGIN: "https://auth.example.invalid/" }],
    ["issuer path", { OAUTH_CANONICAL_ORIGIN: "https://auth.example.invalid/oauth" }],
    ["localhost alias", { OAUTH_CANONICAL_ORIGIN: "http://localhost:4174" }],
    ["unfixed loopback port", { OAUTH_CANONICAL_ORIGIN: "http://127.0.0.1" }],
    ["wrong resource", { OAUTH_NATIVE_API_RESOURCE: "https://api.example.invalid" }],
    ["untrusted dashboard", { OAUTH_DASHBOARD_ORIGIN: "https://other.example.invalid" }],
  ])("rejects %s", (_name, override) => {
    expect(() =>
      decodeOAuthBackendConfig({ ...localEnvironment, ...override }, ["http://127.0.0.1:4173"]),
    ).toThrow();
  });

  it("requires a bounded internal source-network allowlist for internal ingress", () => {
    expect(() =>
      decodeOAuthBackendConfig({ ...localEnvironment, BACKEND_INGRESS: "internal" }, [
        "http://127.0.0.1:4173",
      ]),
    ).toThrow("OAUTH_INTERNAL_SOURCE_NETWORKS is required");

    expect(
      decodeOAuthBackendConfig(
        {
          ...localEnvironment,
          BACKEND_INGRESS: "internal",
          OAUTH_INTERNAL_SOURCE_NETWORKS: "127.0.0.1/32,10.20.0.0/16",
        },
        ["http://127.0.0.1:4173"],
      ).internalSourceNetworks,
    ).toEqual(["127.0.0.1/32", "10.20.0.0/16"]);
  });
});
