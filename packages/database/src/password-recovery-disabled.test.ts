/**
 * EX-0021: native stable SQL carries upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 */
import { Pool } from "pg";
import { afterAll, expect, layer } from "@effect/vitest";
import { DatabaseTestLive, TestPlatform } from "./test-support/platform.js";
import { Database } from "./service.js";
import { makeBetterAuthCallbackRunner } from "./auth-engine.js";
import { Effect, Layer } from "effect";
import { makeAuthEngineOptions } from "./auth-engine.js";
import { OAUTH_NATIVE_API_RESOURCE } from "./oauth-config.js";
import { SecretEqualityLive } from "./web-crypto.js";

const database = new Pool();

afterAll(() => database.end());

layer(
  Layer.merge(DatabaseTestLive(), SecretEqualityLive(globalThis.crypto.subtle)).pipe(
    Layer.provideMerge(TestPlatform),
  ),
  { excludeTestServices: true, timeout: "30 seconds" },
)("native password recovery release boundary", (it) => {
  it.effect("keeps recovery callbacks absent without the owned outbox boundary", () =>
    Effect.gen(function* () {
      const sql = yield* Database;
      const run = yield* makeBetterAuthCallbackRunner;
      const diagnostics: string[] = [];

      const options = makeAuthEngineOptions(
        {
          postgresUrl: "postgresql://unused.example.invalid/unused",
          secret: "not-used-by-option-construction",
          oauth: {
            canonicalOrigin: "https://dashboard.example.invalid",
            dashboardOrigin: "https://dashboard.example.invalid",
            nativeApiResource: OAUTH_NATIVE_API_RESOURCE,
          },
          trustedOrigins: ["https://dashboard.example.invalid"],
          secureCookies: true,
        },
        database,
        sql,
        run,
        () => {
          diagnostics.push("auth diagnostic");
        },
      );

      expect(options.emailAndPassword).toMatchObject({
        enabled: true,
        disableSignUp: true,
        minPasswordLength: 12,
        resetPasswordTokenExpiresIn: 3600,
        revokeSessionsOnPasswordReset: true,
      });
      expect(options.emailAndPassword).not.toHaveProperty("sendResetPassword");
      expect(options.emailAndPassword).not.toHaveProperty("onPasswordReset");
      expect(diagnostics).toEqual([]);
    }),
  );
});
