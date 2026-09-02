import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { makeAuthEngineOptions } from "./auth-engine.js";
import {
  OAUTH_NATIVE_API_RESOURCE,
  OAUTH_SCOPES,
  makeOAuthOptions,
  oauthIssuer,
} from "./oauth-config.js";
import { databaseMigrationDefinitions, databaseSchemaRevision } from "./migrations.js";

const oauth = {
  canonicalOrigin: "http://127.0.0.1:4173",
  dashboardOrigin: "http://127.0.0.1:4173",
  nativeApiResource: OAUTH_NATIVE_API_RESOURCE,
} as const;

describe("native OAuth provider composition", () => {
  it("pins the provider dependencies and recorded npm integrity", async () => {
    const manifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const lock = await readFile(new URL("../../../bun.lock", import.meta.url), "utf8");

    expect(manifest).toContain('"better-auth": "1.7.1"');
    expect(manifest).toContain('"@better-auth/oauth-provider": "1.7.1"');
    expect(lock).toContain(
      "sha512-VWIw7ti6rodlbbdSbn0mts/TZcBWUj6YaoIpREmv70eoGmWTa6MPWEbGuUdADQe3Vy4YqysIbmQA6qgRqfLTaw==",
    );
  });

  it("matches the frozen issuer, resource, scopes, lifetimes, and closed grants", () => {
    const options = makeOAuthOptions(oauth);

    expect(oauthIssuer(oauth)).toBe("http://127.0.0.1:4173/api/auth");
    expect(options).toMatchObject({
      loginPage: "http://127.0.0.1:4173/dashboard/login",
      consentPage: "http://127.0.0.1:4173/dashboard/oauth/consent",
      scopes: [...OAUTH_SCOPES],
      enforcePerClientResources: true,
      grantTypes: ["authorization_code", "client_credentials", "refresh_token"],
      accessTokenExpiresIn: 600,
      m2mAccessTokenExpiresIn: 300,
      refreshTokenExpiresIn: 604800,
      refreshTokenReuseInterval: 0,
      codeExpiresIn: 60,
      allowDynamicClientRegistration: false,
      allowUnauthenticatedClientRegistration: false,
      allowPublicClientPrelogin: false,
      prefix: { clientSecret: "vkr_cs_", refreshToken: "vkr_rt_" },
    });
    expect(options.resources).toEqual([
      {
        identifier: OAUTH_NATIVE_API_RESOURCE,
        name: "Vektorprogrammet native API",
        accessTokenTtl: 600,
        refreshTokenTtl: 604800,
        allowedScopes: [...OAUTH_SCOPES],
        signingAlgorithm: "ES256",
        dpopBoundAccessTokensRequired: false,
      },
    ]);
  });

  it("composes JWT and OAuth into the one existing Better Auth engine", () => {
    const engineOptions = makeAuthEngineOptions(
      {
        postgresUrl: "postgres://test.invalid/oauth",
        secret: "oauth-config-focused-test-secret-32-bytes",
        oauth,
        trustedOrigins: [oauth.dashboardOrigin],
        secureCookies: false,
      },
      {} as Pool,
    );

    expect(engineOptions.baseURL).toBe(oauth.canonicalOrigin);
    expect(engineOptions.basePath).toBe("/api/auth");
    expect(engineOptions.plugins.map(({ id }) => id)).toEqual(["jwt", "oauth-provider"]);
    expect(engineOptions.plugins[0]!.options).toMatchObject({
      jwks: {
        keyPairConfig: { alg: "ES256" },
        disablePrivateKeyEncryption: false,
        rotationInterval: 604800,
        gracePeriod: 900,
      },
      jwt: { issuer: "http://127.0.0.1:4173/api/auth" },
    });
  });
});

describe("native OAuth migration", () => {
  it("keeps native OAuth migration 27 before the service-grant and HTTP semantics migrations", async () => {
    const migration = databaseMigrationDefinitions.find(
      ({ id }) => id === "27_native-oauth-provider",
    )!;
    const sql = await readFile(migration.url, "utf8");

    expect(databaseSchemaRevision).toBe("29_native_http_semantics");
    expect(migration.id).toBe("27_native-oauth-provider");
    for (const relation of [
      'auth."oauthClient"',
      'auth."oauthResource"',
      'auth."oauthClientResource"',
      'auth."oauthRefreshToken"',
      'auth."oauthAccessToken"',
      'auth."oauthConsent"',
      'auth."oauthClientAssertion"',
      "auth.jwks",
      "public.service_principals",
      "auth.oauth_client_bindings",
      "auth.oauth_refresh_families",
      "auth.oauth_access_token_state",
      "auth.oauth_security_audit",
    ]) {
      expect(sql).toContain(relation);
    }
    expect(sql).toContain("oauth_security_audit_no_update");
    expect(sql).not.toContain("public.authz_rules");
    expect(sql).not.toContain("ALTER TABLE public.authz_rules");
  });
});
