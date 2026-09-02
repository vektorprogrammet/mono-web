import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { makeAuthEngineOptions } from "./auth-engine.js";
import { OAUTH_NATIVE_API_RESOURCE } from "./oauth-config.js";

const database = Object.create(null) as Pool;

describe("native password recovery release boundary", () => {
  it("keeps Better Auth recovery disabled until the outbox and cohort cutover", () => {
    const options = makeAuthEngineOptions(
      {
        postgresUrl: "postgresql://unused.example.invalid/unused",
        secret: "not-used-by-option-construction",
        oauth: {
          canonicalOrigin: "https://vektor.phibkro.org",
          dashboardOrigin: "https://vektor.phibkro.org",
          nativeApiResource: OAUTH_NATIVE_API_RESOURCE,
        },
        trustedOrigins: ["https://vektor.phibkro.org"],
        secureCookies: true,
      },
      database,
    );

    expect(options.emailAndPassword).toEqual({
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    });
    expect(options.emailAndPassword).not.toHaveProperty("sendResetPassword");
    expect(options.emailAndPassword).not.toHaveProperty("onPasswordReset");
    expect(options.emailAndPassword).not.toHaveProperty("revokeSessionsOnPasswordReset");
  });
});
