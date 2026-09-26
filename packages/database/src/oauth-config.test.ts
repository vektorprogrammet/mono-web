import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { Effect } from "effect";
import { makeAuthEngineOptions } from "./auth-engine.js";
import {
  OAUTH_NATIVE_API_RESOURCE,
  OAUTH_SCOPES,
  makeOAuthOptions,
  oauthIssuer,
} from "./oauth-config.js";

const oauth = {
  canonicalOrigin: "http://127.0.0.1:4173",
  dashboardOrigin: "http://127.0.0.1:4173",
  nativeApiResource: OAUTH_NATIVE_API_RESOURCE,
} as const;

describe("native OAuth provider composition", () => {
  const pool = new Pool();

  afterAll(() => pool.end());

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
      pool,
      Effect.runPromise,
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
